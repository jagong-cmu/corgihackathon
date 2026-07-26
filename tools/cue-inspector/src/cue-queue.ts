/**
 * The cue queue — a queue keyed to audio playback position, not to timers.
 *
 * This is deliberately the same shape the real tldraw client will need (§4):
 * frames arrive over the data channel carrying a `cueMs` offset into their
 * turn's audio; the client holds them and applies each one when the audio
 * reaches that offset. The difference is only in what happens at fire time —
 * here we record a row, there you call `editor.createShape()`.
 *
 * ## Turn origins
 *
 * `cueMs` is relative to the start of that turn's audio, but the audio arrives
 * as one continuous stream with no turn markers in it. So we infer the origin:
 * the first frame we receive for a turn pins it at
 *
 *     origin = playbackPosition(arrival) - frame.cueMs
 *
 * which is exact if that frame arrived on time and biased late by exactly that
 * frame's own delivery latency otherwise. Since the agent emits seq 0 with
 * cueMs 0 at the top of a turn (both fixtures do), the bias is one frame's
 * transport latency and it applies uniformly to the whole turn. The inspector
 * shows the inferred origin per turn so you can see what it assumed.
 *
 * A real client will do better than this — it knows locally when it started
 * playing each turn's audio, because it is the thing doing the playing.
 *
 * Two consequences worth knowing before you trust a number in the table:
 *
 *   - Frames routinely arrive before the audio track is even subscribed (the
 *     data channel comes up first). Their implied origin is negative and gets
 *     clamped to 0, which is the right answer: the turn's audio starts when
 *     playback starts.
 *   - If the anchor frame itself was delivered late, the whole turn's origin is
 *     late with it and every drift in that turn is understated by the same
 *     amount. This is not detectable from inside the client — under burst
 *     delivery every frame arrives at once, so nothing contradicts a late
 *     anchor. Read the arrival column, and trust the agent-side send log when
 *     the two disagree.
 *
 * ## Drift
 *
 *   arrivalMs — playback position when the frame landed (turn-relative)
 *   actualMs  — playback position when the cue actually fired
 *   driftMs   — actualMs - cueMs
 *
 * Drift has exactly two sources, and the arrival column tells you which:
 * a frame that arrived after its own cue time had already passed fires late no
 * matter what the client does (transport), and everything else is the poll
 * granularity of the tick loop (rendering).
 */

import type { AgentMessage, CanvasActionMessage } from "@tutor/canvas-protocol";
import type { PlaybackClock } from "./clock.ts";

export type CueStatus = "pending" | "fired" | "cancelled";

/** How long cues may sit with no playback clock before it is worth saying so. */
const CLOCK_STARVATION_GRACE_MS = 1_500;

export interface CueRow {
  /** Monotonic id for stable DOM row identity. */
  readonly id: number;
  readonly turnId: string;
  readonly seq: number;
  readonly actionType: string;
  readonly cueMs: number;
  /** Playback position, turn-relative, when the frame arrived. */
  readonly arrivalMs: number;
  status: CueStatus;
  /** Playback position, turn-relative, when the cue fired. */
  actualMs?: number;
  driftMs?: number;
  /** Why an unfired cue was dropped: explicit cancel_turn, or superseded. */
  cancelReason?: string;
  readonly action: CanvasActionMessage["action"];
}

export interface TurnState {
  readonly turnId: string;
  /** Playback position the turn's audio is assumed to have started at. */
  readonly originMs: number;
  cancelled: boolean;
}

export interface CueQueueEvents {
  onRowAdded(row: CueRow): void;
  onRowChanged(row: CueRow): void;
  onTurnChanged(turn: TurnState): void;
  onWarning(message: string, detail?: unknown): void;
}

export class CueQueue {
  private readonly clock: PlaybackClock;
  private readonly events: CueQueueEvents;
  private readonly turns = new Map<string, TurnState>();
  private readonly rows: CueRow[] = [];
  /** Unfired cues, kept sorted by (cueMs, seq) — the §4 tie-break rule. */
  private pending: CueRow[] = [];
  private nextRowId = 0;
  private activeTurnId: string | null = null;
  private warnedNoClock = false;
  /** Wall-clock ms when cues first started waiting without a clock. */
  private starvedSinceWallMs: number | null = null;

  constructor(clock: PlaybackClock, events: CueQueueEvents) {
    this.clock = clock;
    this.events = events;
  }

  get allRows(): readonly CueRow[] {
    return this.rows;
  }

  get turnStates(): readonly TurnState[] {
    return [...this.turns.values()];
  }

  /**
   * Accept one already-validated agent message. Validation happens at the
   * transport boundary (§13) so nothing unvalidated ever reaches this queue.
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
      // First frame of a new turn. §4: this implicitly cancels any unfired
      // cues from the previous turn — that is what barge-in looks like on the
      // wire when the agent does not get a cancel_turn out in time.
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
      this.events.onTurnChanged(turn);
    }

    const row: CueRow = {
      id: this.nextRowId++,
      turnId: frame.turnId,
      seq: frame.seq,
      actionType: frame.action.type,
      cueMs: frame.cueMs,
      arrivalMs: Math.round(pos - turn.originMs),
      status: "pending",
      action: frame.action,
    };
    this.rows.push(row);
    this.events.onRowAdded(row);

    if (turn.cancelled) {
      // A frame for a turn that was already cancelled. Show it rather than
      // dropping it silently — a burst of these means the agent kept emitting
      // after a barge-in, which is a bug worth seeing.
      this.settleCancelled(row, "arrived after turn was cancelled");
      return;
    }

    // The data channel comes up before the audio track subscribes, so frames
    // routinely land a few tens of ms before there is a clock. That is normal;
    // only a sustained absence is worth warning about. tick() decides.
    if (!this.clock.playing && this.starvedSinceWallMs === null) {
      this.starvedSinceWallMs = Date.now();
    }

    this.insertPending(row);
  }

  private insertPending(row: CueRow): void {
    this.pending.push(row);
    // Sorted by (cueMs, seq): actions within a turn apply in seq order
    // regardless of arrival order, and ties break on seq (§4).
    this.pending.sort((a, b) => a.cueMs - b.cueMs || a.seq - b.seq);
  }

  /**
   * Mark every unfired cue for a turn as cancelled. Rows stay in the table —
   * the point of the harness is that barge-in is *visible*, and a dropped row
   * looks identical to a cue that was never sent.
   */
  cancelTurn(turnId: string, reason: string): void {
    const turn = this.turns.get(turnId);
    if (turn) {
      turn.cancelled = true;
      this.events.onTurnChanged(turn);
    } else {
      // cancel_turn for a turn we never saw a frame from. Nothing to mark, but
      // record the turn so a late frame for it is handled correctly.
      const ghost: TurnState = { turnId, originMs: this.clock.positionMs, cancelled: true };
      this.turns.set(turnId, ghost);
      this.events.onTurnChanged(ghost);
    }
    if (this.activeTurnId === turnId) this.activeTurnId = null;

    const survivors: CueRow[] = [];
    for (const row of this.pending) {
      if (row.turnId === turnId) this.settleCancelled(row, reason);
      else survivors.push(row);
    }
    this.pending = survivors;
  }

  /**
   * Cues are waiting but the audio never started. Wall-clock time is used here
   * and ONLY here: this is a UI liveness check, not a measurement. Nothing that
   * lands in the table is ever timed off it.
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
      `${this.pending.length} cue(s) are waiting but no audio is playing — the playback clock is ` +
        "frozen, so nothing past 0ms can fire. Subscribe to the tutor's audio track, start a local " +
        "replay, or press play if autoplay was blocked.",
    );
  }

  private settleCancelled(row: CueRow, reason: string): void {
    row.status = "cancelled";
    row.cancelReason = reason;
    this.events.onRowChanged(row);
  }

  /**
   * Fire every cue the audio has reached. Call this from a rAF loop; the poll
   * granularity is itself part of what the drift column measures, so it is
   * deliberately not hidden behind timers.
   */
  tick(): void {
    this.checkForStarvedClock();
    if (this.pending.length === 0) return;
    const pos = this.clock.positionMs;

    const survivors: CueRow[] = [];
    for (const row of this.pending) {
      const turn = this.turns.get(row.turnId);
      if (!turn) continue;
      const dueAt = turn.originMs + row.cueMs;
      if (pos >= dueAt) {
        const actual = Math.round(pos - turn.originMs);
        row.status = "fired";
        row.actualMs = actual;
        row.driftMs = actual - row.cueMs;
        this.events.onRowChanged(row);
      } else {
        survivors.push(row);
      }
    }
    this.pending = survivors;
  }

  reset(): void {
    this.turns.clear();
    this.rows.length = 0;
    this.pending = [];
    this.activeTurnId = null;
    this.warnedNoClock = false;
    this.starvedSinceWallMs = null;
  }
}

/** Colour bands from the brief: <50ms green, <150ms amber, above red. */
export function driftBand(driftMs: number): "good" | "warn" | "bad" {
  const d = Math.abs(driftMs);
  if (d < 50) return "good";
  if (d < 150) return "warn";
  return "bad";
}
