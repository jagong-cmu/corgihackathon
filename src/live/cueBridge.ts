/**
 * cueBridge — fires canvas actions when the tutor's AUDIO reaches them.
 *
 * This is the client half of the voice↔whiteboard sync. The agent worker
 * anchors every canvas action to the TTS character timestamps of the words it
 * belongs to and ships it as a `canvas_action` frame with a `cueMs` offset
 * into its turn's audio. This module holds those frames and applies each one
 * when playback reaches its offset.
 *
 * Everything is measured against `HTMLMediaElement.currentTime`, never
 * wall-clock time — a stalled or rebuffering track freezes playback while
 * `Date.now()` sails on, which is exactly the desync this exists to prevent.
 * (Same rule as tools/cue-inspector, which this queue is adapted from; see
 * its cue-queue.ts for the measurement rationale in full.)
 *
 * Turn origins: `cueMs` is relative to the start of that turn's audio, but
 * the audio arrives as one continuous MediaStream with no turn markers. The
 * first frame of a turn pins the origin at
 *
 *     origin = playbackPosition(arrival) - frame.cueMs
 *
 * clamped to >= 0 because the data channel routinely comes up before the
 * audio track is subscribed. The bias is one frame's transport latency and it
 * applies uniformly to the whole turn — tens of ms in practice, well inside
 * the <150ms band the cue-inspector calls acceptable.
 */
import {
  safeParseAgentMessage,
  type AgentMessage,
  type CanvasAction,
  type CanvasActionMessage,
} from "@tutor/canvas-protocol";

/** LiveKit data-channel topic the agent publishes canvas traffic on. */
export const CANVAS_TOPIC = "canvas";

export interface BoardCue {
  turnId: string;
  seq: number;
  cueMs: number;
  action: CanvasAction;
}

/**
 * Playback position of whichever tutor audio element is current. Rebased on
 * attach: a MediaStream-backed element's currentTime starts counting when the
 * element starts rendering, not when our turn's audio starts, so swapping
 * sources must restart the timeline rather than inherit a stale position.
 */
export class PlaybackClock {
  private el: HTMLMediaElement | null = null;
  private attachedAtMs = 0;

  attach(el: HTMLMediaElement): void {
    this.el = el;
    this.attachedAtMs = el.currentTime * 1000;
  }

  /** Forget `el` if it is the current source (track unsubscribed). */
  detach(el: HTMLMediaElement): void {
    if (this.el === el) {
      this.el = null;
      this.attachedAtMs = 0;
    }
  }

  get positionMs(): number {
    if (!this.el) return 0;
    return Math.max(0, this.el.currentTime * 1000 - this.attachedAtMs);
  }

  get playing(): boolean {
    return this.el !== null && !this.el.paused && !this.el.ended;
  }
}

interface TurnState {
  originMs: number;
  cancelled: boolean;
}

/**
 * Holds validated `canvas_action` frames and fires each one when the clock
 * reaches `origin + cueMs`. Implements the §4 ordering rules: cues apply in
 * (cueMs, seq) order regardless of arrival order, an explicit `cancel_turn`
 * drops a turn's unfired cues, and a new turn's first frame implicitly
 * cancels the previous turn — that is what barge-in looks like on the wire
 * when the agent doesn't get a cancel out in time.
 */
export class LiveCueQueue {
  private readonly clock: PlaybackClock;
  private readonly onFire: (cue: BoardCue) => void;
  private turns = new Map<string, TurnState>();
  private pending: BoardCue[] = [];
  private activeTurnId: string | null = null;

  constructor(clock: PlaybackClock, onFire: (cue: BoardCue) => void) {
    this.clock = clock;
    this.onFire = onFire;
  }

  /**
   * One raw data-channel payload. Malformed or unknown frames are dropped
   * silently (§13): a missing arrow is invisible, a crashed board ends the
   * lesson.
   */
  acceptRaw(payload: Uint8Array): void {
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return;
    }
    const message = safeParseAgentMessage(raw);
    if (message) this.accept(message);
  }

  accept(message: AgentMessage): void {
    if (message.type === "cancel_turn") {
      this.cancelTurn(message.turnId);
      return;
    }
    this.enqueue(message);
  }

  private enqueue(frame: CanvasActionMessage): void {
    let turn = this.turns.get(frame.turnId);
    if (!turn) {
      if (this.activeTurnId && this.activeTurnId !== frame.turnId) {
        this.cancelTurn(this.activeTurnId);
      }
      turn = {
        originMs: Math.max(0, this.clock.positionMs - frame.cueMs),
        cancelled: false,
      };
      this.turns.set(frame.turnId, turn);
      this.activeTurnId = frame.turnId;
    }
    if (turn.cancelled) return; // late frame for a barged-in turn

    this.pending.push({
      turnId: frame.turnId,
      seq: frame.seq,
      cueMs: frame.cueMs,
      action: frame.action,
    });
    this.pending.sort((a, b) => a.cueMs - b.cueMs || a.seq - b.seq);
  }

  cancelTurn(turnId: string): void {
    const turn = this.turns.get(turnId);
    if (turn) {
      turn.cancelled = true;
    } else {
      // cancel_turn for a turn we never saw a frame from — record it so a
      // late frame for it is still dropped.
      this.turns.set(turnId, { originMs: this.clock.positionMs, cancelled: true });
    }
    if (this.activeTurnId === turnId) this.activeTurnId = null;
    this.pending = this.pending.filter((cue) => cue.turnId !== turnId);
  }

  /** Fire every cue the audio has reached. Call from a rAF loop. */
  tick(): void {
    if (this.pending.length === 0) return;
    const pos = this.clock.positionMs;

    const survivors: BoardCue[] = [];
    for (const cue of this.pending) {
      const turn = this.turns.get(cue.turnId);
      if (!turn || turn.cancelled) continue;
      if (pos >= turn.originMs + cue.cueMs) {
        this.onFire(cue);
      } else {
        survivors.push(cue);
      }
    }
    this.pending = survivors;
  }

  reset(): void {
    this.turns.clear();
    this.pending = [];
    this.activeTurnId = null;
  }
}
