/**
 * Turns a fixture's message list into a timed replay plan.
 *
 * Pure and shared: the browser's local replay and the Node replay script both
 * build the plan the same way, so a row you see with no LiveKit credentials
 * means the same thing as a row you see over a real room.
 *
 * ## How fixture messages become times
 *
 * A fixture is an ordered list, not a schedule. `cueMs` is turn-relative, and
 * a fixture may contain several turns, so the plan lays turns end to end on
 * one session timeline:
 *
 *     turnBase(first turn) = 0
 *     turnBase(next turn)  = end of the previous turn + TURN_GAP_MS
 *     absolute cue time    = turnBase + cueMs
 *
 * The audio rendered for the plan spans that whole timeline, which is what
 * makes the inspector's playback clock — one continuous stream with no turn
 * markers in it — behave the way it will in a real session.
 *
 * ## Delivery modes
 *
 * `burst` is what the agent actually does: cue times are only known once TTS
 * returns character timings, so the whole turn's frames go out together as the
 * turn's audio starts. Drift then measures only the client's own poll
 * granularity, which is the healthy baseline.
 *
 * `streamed` delivers each frame near its own cue time instead. With `jitterMs`
 * it is the pessimistic case — it is how you make the amber and red bands
 * appear on demand and confirm the colouring is wired up.
 */

export type DeliveryMode = "burst" | "streamed";

export interface ReplayOptions {
  mode?: DeliveryMode;
  /** Extra delivery lateness, ms, sampled per frame in streamed mode. */
  jitterMs?: number;
  /**
   * Retime any cancel_turn frame to this many ms into its turn. A fixture's
   * cancel usually sits after the turn's last action, where it cancels
   * nothing; moving it earlier is how you see barge-in mark real rows.
   */
  bargeInAtMs?: number;
  /** Deterministic jitter source, so a replay can be reproduced. */
  random?: () => number;
}

export interface PlannedFrame {
  /** ms into the session timeline at which to publish this frame. */
  deliverAtMs: number;
  /** The raw fixture message, untouched — it must fail or pass validation as written. */
  message: unknown;
  /** For logging only. */
  label: string;
}

export interface ReplayPlan {
  frames: PlannedFrame[];
  /** Absolute cue times, for the audio blips. */
  cueMarksMs: number[];
  durationMs: number;
}

const TURN_GAP_MS = 600;
/** Spacing for frames that carry no cueMs of their own (cancel_turn etc). */
const UNCUED_SPACING_MS = 80;
const TAIL_MS = 1_500;

interface FixtureMessage {
  type?: unknown;
  turnId?: unknown;
  seq?: unknown;
  cueMs?: unknown;
}

export function planReplay(messages: readonly unknown[], options: ReplayOptions = {}): ReplayPlan {
  const mode = options.mode ?? "burst";
  const jitterMs = options.jitterMs ?? 0;
  const random = options.random ?? Math.random;

  const frames: PlannedFrame[] = [];
  const cueMarksMs: number[] = [];

  let cursor = 0;
  let turnBase = 0;
  let currentTurn: string | null = null;
  // Where each turn's audio starts, so a retimed cancel lands inside its turn.
  const turnBases = new Map<string, number>();

  for (const raw of messages) {
    const message = raw as FixtureMessage;

    if (message.type === "canvas_action") {
      const turnId = typeof message.turnId === "string" ? message.turnId : "unknown";
      const cueMs = typeof message.cueMs === "number" ? message.cueMs : 0;

      let isAnchor = false;
      if (turnId !== currentTurn) {
        currentTurn = turnId;
        turnBase = frames.length === 0 ? 0 : cursor + TURN_GAP_MS;
        turnBases.set(turnId, turnBase);
        isAnchor = true;
      }

      const absoluteCue = turnBase + cueMs;
      cueMarksMs.push(absoluteCue);
      cursor = Math.max(cursor, absoluteCue);

      // The turn's first frame is the anchor the inspector infers the turn
      // origin from, so it is always delivered on time. Jittering it would
      // just move the whole turn's frame of reference and hide the lateness
      // you asked for — see the origin-bias warning in cue-queue.ts.
      const deliverAtMs =
        mode === "burst" || isAnchor
          ? turnBase
          : absoluteCue + Math.round(random() * jitterMs);

      frames.push({
        deliverAtMs,
        message: raw,
        label: `${turnId} seq ${String(message.seq ?? "?")} ${describeAction(raw)} @${cueMs}ms`,
      });
      continue;
    }

    // Frames with no cue of their own: cancel_turn, and the student_events the
    // fixtures interleave (which the inspector will classify as client-bound
    // and ignore — that path is worth exercising too).
    let deliverAtMs = cursor + UNCUED_SPACING_MS;
    if (message.type === "cancel_turn" && options.bargeInAtMs !== undefined) {
      const turnId = typeof message.turnId === "string" ? message.turnId : "";
      deliverAtMs = (turnBases.get(turnId) ?? 0) + options.bargeInAtMs;
    }
    cursor = Math.max(cursor, deliverAtMs);
    frames.push({
      deliverAtMs,
      message: raw,
      label: `${String(message.type ?? "?")}${
        typeof message.turnId === "string" ? ` ${message.turnId}` : ""
      }`,
    });
  }

  frames.sort((a, b) => a.deliverAtMs - b.deliverAtMs);

  return {
    frames,
    cueMarksMs,
    durationMs: Math.max(cursor, ...cueMarksMs, 0) + TAIL_MS,
  };
}

function describeAction(raw: unknown): string {
  const action = (raw as { action?: { type?: unknown } }).action;
  return typeof action?.type === "string" ? action.type : "?";
}

/**
 * The fixture files wrap their messages in metadata. Kept tolerant on purpose:
 * a malformed fixture should surface as a clear error here, not as a schema
 * failure sixteen frames later.
 */
export function messagesFromFixture(fixture: unknown): unknown[] {
  const messages = (fixture as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    throw new Error("fixture has no `messages` array");
  }
  return messages;
}
