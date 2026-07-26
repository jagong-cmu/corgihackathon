/**
 * The cue queue — actions keyed to audio playback position, not to timers.
 *
 * Frames arrive over the data channel carrying a `cueMs` offset into their
 * turn's audio. The queue holds each one and applies it when the audio reaches
 * that offset, so "point at this term" lands on the word "this".
 *
 * This is the same queue shape the cue-inspector validated against real rooms
 * (`tools/cue-inspector/src/cue-queue.ts`); the difference is only what happens
 * at fire time — there it appends a row to a drift table, here it mutates the
 * board.
 *
 * ## Turn origins are inferred
 *
 * `cueMs` is relative to the start of its turn's audio, but the tutor's audio
 * arrives as one continuous WebRTC stream with no turn markers in it. So the
 * first frame of a turn pins the origin:
 *
 *     origin = playbackPosition(arrival) - frame.cueMs
 *
 * That is exact when the anchor frame arrived on time, and late by exactly that
 * frame's delivery latency otherwise. The agent emits seq 0 at cueMs 0 at the
 * top of a turn, so the bias is one frame of transport latency applied
 * uniformly across the turn — visible in the drift numbers as a constant
 * offset, not as an action landing on the wrong word.
 *
 * Two consequences worth knowing:
 *
 *   - Frames routinely arrive before the audio track is even subscribed; the
 *     data channel comes up first. Their implied origin is negative and clamps
 *     to 0, which is right: the turn's audio starts when playback starts.
 *   - If the anchor frame itself was late, the whole turn's origin is late with
 *     it and the client cannot tell — under burst delivery every frame arrives
 *     at once, so nothing contradicts it. The agent-side send log is the
 *     tiebreak.
 *
 * ## Ordering and cancellation (§4)
 *
 * Actions within a turn apply in `seq` order regardless of arrival order, ties
 * break on `seq`, and a new turn's first action implicitly cancels the previous
 * turn's unfired cues — which is what barge-in looks like on the wire when the
 * agent could not get a `cancel_turn` out in time.
 */

import type { AgentMessage, CanvasAction, CanvasActionMessage } from "@tutor/canvas-protocol";
import type { PlaybackClock } from "./clock";

/** How long cues may sit with no playback clock before it is worth saying so. */
const CLOCK_STARVATION_GRACE_MS = 1_500;

export interface FiredCue {
  turnId: string;
  seq: number;
  action: CanvasAction;
  /** `actual - cueMs`, in playback time. Small is good; see driftBand. */
  driftMs: number;
}

export interface CueQueueEvents {
  /** Apply this action to the board. Called from the tick loop. */
  onFire(cue: FiredCue): void;
  /** Every unfired cue for a turn was dropped. */
  onCancel(turnId: string, reason: string): void;
  onWarning(message: string): void;
}

interface PendingCue {
  turnId: string;
  seq: number;
  cueMs: number;
  action: CanvasAction;
}

interface TurnState {
  turnId: string;
  originMs: number;
  cancelled: boolean;
}

export class CueQueue {
  private readonly clock: PlaybackClock;
  private readonly events: CueQueueEvents;
  private readonly turns = new Map<string, TurnState>();
  /** Unfired cues, kept sorted by (cueMs, seq). */
  private pending: PendingCue[] = [];
  private activeTurnId: string | null = null;
  private warnedNoClock = false;
  private starvedSinceWallMs: number | null = null;

  constructor(clock: PlaybackClock, events: CueQueueEvents) {
    this.clock = clock;
    this.events = events;
  }

  get activeTurn(): string | null {
    return this.activeTurnId;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Accept one already-validated agent message. Validation happens at the
   * transport boundary (§13), so nothing unvalidated reaches this queue.
   */
  accept(message: AgentMessage): void {
    if (message.type === "cancel_turn") {
      this.cancelTurn(message.turnId, `cancel_turn (${message.reason})`);
      return;
    }
    this.enqueue(message);
  }

  private enqueue(frame: CanvasActionMessage): void {
    const pos = this.clock.positionMs;
    let turn = this.turns.get(frame.turnId);

    if (!turn) {
      if (this.activeTurnId && this.activeTurnId !== frame.turnId) {
        this.cancelTurn(this.activeTurnId, `superseded by ${frame.turnId}`);
      }
      turn = {
        turnId: frame.turnId,
        originMs: Math.max(0, pos - frame.cueMs),
        cancelled: false,
      };
      this.turns.set(frame.turnId, turn);
      this.activeTurnId = frame.turnId;
    }

    if (turn.cancelled) {
      // The agent kept emitting after a barge-in. Dropping is correct; the
      // learner has already moved on.
      return;
    }

    if (!this.clock.playing && this.starvedSinceWallMs === null) {
      this.starvedSinceWallMs = Date.now();
    }

    this.pending.push({
      turnId: frame.turnId,
      seq: frame.seq,
      cueMs: frame.cueMs,
      action: frame.action,
    });
    this.pending.sort((a, b) => a.cueMs - b.cueMs || a.seq - b.seq);
  }

  cancelTurn(turnId: string, reason: string): void {
    const turn = this.turns.get(turnId);
    if (turn) {
      turn.cancelled = true;
    } else {
      // cancel_turn for a turn we never saw a frame from. Record it so a late
      // frame for it is dropped rather than starting a new turn.
      this.turns.set(turnId, {
        turnId,
        originMs: this.clock.positionMs,
        cancelled: true,
      });
    }
    if (this.activeTurnId === turnId) this.activeTurnId = null;

    const before = this.pending.length;
    this.pending = this.pending.filter((cue) => cue.turnId !== turnId);
    if (this.pending.length !== before) {
      this.events.onCancel(turnId, reason);
    }
  }

  /**
   * Fire every cue the audio has reached. Called from a rAF loop; the poll
   * granularity is part of the drift the inspector measures, so it is
   * deliberately not hidden behind timers.
   */
  tick(): void {
    this.checkForStarvedClock();
    if (this.pending.length === 0) return;
    const pos = this.clock.positionMs;

    const survivors: PendingCue[] = [];
    for (const cue of this.pending) {
      const turn = this.turns.get(cue.turnId);
      if (!turn || turn.cancelled) continue;
      const dueAt = turn.originMs + cue.cueMs;
      if (pos >= dueAt) {
        const actual = Math.round(pos - turn.originMs);
        this.events.onFire({
          turnId: cue.turnId,
          seq: cue.seq,
          action: cue.action,
          driftMs: actual - cue.cueMs,
        });
      } else {
        survivors.push(cue);
      }
    }
    this.pending = survivors;
  }

  /**
   * Cues are waiting but the audio never started. Wall-clock time is used here
   * and ONLY here: this is a liveness check, not a measurement.
   */
  private checkForStarvedClock(): void {
    if (this.clock.playing) {
      this.starvedSinceWallMs = null;
      return;
    }
    if (this.warnedNoClock || this.starvedSinceWallMs === null) return;
    if (this.pending.length === 0) return;
    if (Date.now() - this.starvedSinceWallMs < CLOCK_STARVATION_GRACE_MS) return;

    this.warnedNoClock = true;
    this.events.onWarning(
      `${this.pending.length} board action(s) are waiting on audio that is not playing. ` +
        "Browsers block autoplay until you interact with the page — click anywhere to start it.",
    );
  }

  reset(): void {
    this.turns.clear();
    this.pending = [];
    this.activeTurnId = null;
    this.warnedNoClock = false;
    this.starvedSinceWallMs = null;
  }
}

/** <50ms green, <150ms amber, above red. */
export function driftBand(driftMs: number): "good" | "warn" | "bad" {
  const d = Math.abs(driftMs);
  if (d < 50) return "good";
  if (d < 150) return "warn";
  return "bad";
}
