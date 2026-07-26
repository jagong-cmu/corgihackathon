/**
 * The cue queue.
 *
 * This is the mechanism the whole product rests on: an action fires when the
 * audio reaches the words it belongs to. Everything here is driven by a fake
 * clock, so the assertions are about playback position and never about elapsed
 * wall time — which is also the property the implementation has to maintain.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CueQueue, driftBand, type FiredCue } from "./cueQueue";
import type { AgentMessage, CanvasAction } from "@tutor/canvas-protocol";

/** A clock we can move by hand, matching PlaybackClock's shape. */
class FakeClock {
  positionMs = 0;
  playing = true;
  el = null as unknown as HTMLAudioElement;
  kind = "livekit-track" as const;
  markAttached() {}
  detach() {}
}

function frame(turnId: string, seq: number, cueMs: number, type = "highlight"): AgentMessage {
  return {
    type: "canvas_action",
    turnId,
    seq,
    cueMs,
    action: { type, target: `shape_${seq}`, color: "yellow" } as CanvasAction,
  } as AgentMessage;
}

describe("CueQueue", () => {
  let clock: FakeClock;
  let fired: FiredCue[];
  let cancelled: Array<{ turnId: string; reason: string }>;
  let queue: CueQueue;

  beforeEach(() => {
    clock = new FakeClock();
    fired = [];
    cancelled = [];
    queue = new CueQueue(clock as never, {
      onFire: (cue) => fired.push(cue),
      onCancel: (turnId, reason) => cancelled.push({ turnId, reason }),
      onWarning: () => {},
    });
  });

  it("holds an action until the audio reaches its cue", () => {
    queue.accept(frame("t_0001", 0, 0));
    queue.accept(frame("t_0001", 1, 2000));
    queue.tick();
    expect(fired).toHaveLength(1); // only the cueMs 0 action

    clock.positionMs = 1999;
    queue.tick();
    expect(fired).toHaveLength(1);

    clock.positionMs = 2000;
    queue.tick();
    expect(fired).toHaveLength(2);
  });

  it("applies actions in seq order even when they arrive out of order", () => {
    // §4: ordering within a turn is by seq, not by arrival. Reliable delivery
    // makes this rare, but 'rare' and 'never' are different.
    queue.accept(frame("t_0001", 2, 500));
    queue.accept(frame("t_0001", 1, 500));
    queue.accept(frame("t_0001", 0, 500));

    clock.positionMs = 600;
    queue.tick();
    expect(fired.map((f) => f.seq)).toEqual([0, 1, 2]);
  });

  it("reports drift against the turn's inferred origin", () => {
    queue.accept(frame("t_0001", 0, 0)); // anchors origin at 0
    queue.accept(frame("t_0001", 1, 1000));

    clock.positionMs = 1080; // 80ms late
    queue.tick();
    const late = fired.find((f) => f.seq === 1);
    expect(late?.driftMs).toBe(80);
  });

  it("infers the turn origin from the first frame of the turn", () => {
    // The turn's audio starts partway through a continuous stream, so cueMs 0
    // for t_0002 does not mean playback position 0.
    clock.positionMs = 5000;
    queue.accept(frame("t_0002", 0, 0));
    queue.accept(frame("t_0002", 1, 400));
    queue.tick();
    expect(fired).toHaveLength(1);

    clock.positionMs = 5400;
    queue.tick();
    expect(fired).toHaveLength(2);
    expect(fired[1].driftMs).toBe(0);
  });

  it("clamps a negative origin to zero", () => {
    // Frames routinely arrive before the audio track is even subscribed, so
    // the implied origin is negative. The turn's audio starts when playback
    // starts, which is position 0.
    queue.accept(frame("t_0001", 0, 3000));
    clock.positionMs = 3000;
    queue.tick();
    expect(fired).toHaveLength(1);
  });

  describe("barge-in", () => {
    it("cancel_turn drops every unfired cue for that turn", () => {
      queue.accept(frame("t_0001", 0, 0));
      queue.accept(frame("t_0001", 1, 5000));
      queue.tick();

      queue.accept({ type: "cancel_turn", turnId: "t_0001", reason: "barge_in" } as AgentMessage);
      clock.positionMs = 6000;
      queue.tick();

      // The first fired before the cancel; the second must never land.
      expect(fired).toHaveLength(1);
      expect(cancelled[0]).toMatchObject({ turnId: "t_0001" });
    });

    it("a new turn implicitly cancels the previous one", () => {
      // This is what barge-in looks like on the wire when the agent could not
      // get a cancel_turn out in time.
      queue.accept(frame("t_0001", 0, 0));
      queue.tick(); // the first action lands before the interruption
      expect(fired.map((f) => f.turnId)).toEqual(["t_0001"]);

      queue.accept(frame("t_0001", 1, 5000));
      queue.accept(frame("t_0002", 0, 0));

      clock.positionMs = 6000;
      queue.tick();

      // t_0001's unfired cue is dead; t_0002 takes over.
      expect(fired.map((f) => f.turnId)).toEqual(["t_0001", "t_0002"]);
      expect(cancelled[0].reason).toContain("superseded by t_0002");
    });

    it("late frames for a cancelled turn are dropped", () => {
      queue.accept(frame("t_0001", 0, 0));
      queue.accept({ type: "cancel_turn", turnId: "t_0001", reason: "barge_in" } as AgentMessage);
      fired.length = 0;

      queue.accept(frame("t_0001", 1, 100));
      clock.positionMs = 200;
      queue.tick();
      // The agent kept emitting after the interruption; the learner has moved on.
      expect(fired).toHaveLength(0);
    });

    it("a cancel for a turn we never saw still blocks its frames", () => {
      queue.accept({ type: "cancel_turn", turnId: "t_0009", reason: "error" } as AgentMessage);
      queue.accept(frame("t_0009", 0, 0));
      queue.tick();
      expect(fired).toHaveLength(0);
    });
  });

  it("warns when cues are waiting but audio never started", () => {
    vi.useFakeTimers();
    const warnings: string[] = [];
    const stalled = new FakeClock();
    stalled.playing = false;
    const q = new CueQueue(stalled as never, {
      onFire: () => {},
      onCancel: () => {},
      onWarning: (m) => warnings.push(m),
    });

    q.accept(frame("t_0001", 0, 500));
    q.tick();
    expect(warnings).toHaveLength(0); // within the grace period

    vi.advanceTimersByTime(2000);
    q.tick();
    // Without this the failure is invisible: a silent board and no explanation.
    expect(warnings[0]).toMatch(/autoplay|not playing/i);
    vi.useRealTimers();
  });

  it("reset clears everything", () => {
    queue.accept(frame("t_0001", 0, 9000));
    expect(queue.pendingCount).toBe(1);
    queue.reset();
    expect(queue.pendingCount).toBe(0);
    expect(queue.activeTurn).toBeNull();
  });
});

describe("driftBand", () => {
  it.each([
    [0, "good"],
    [49, "good"],
    [-49, "good"],
    [50, "warn"],
    [149, "warn"],
    [150, "bad"],
    [-800, "bad"],
  ])("%dms is %s", (drift, band) => {
    expect(driftBand(drift)).toBe(band);
  });
});
