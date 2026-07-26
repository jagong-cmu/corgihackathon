/**
 * Local replay: fixtures + generated audio, entirely in the browser.
 *
 * The LiveKit path needs credentials, a room, and something publishing into
 * it. This path needs none of that and exercises exactly the same validation
 * boundary, cue queue, and playback clock, so the harness is useful the moment
 * `npm run dev` is up. The Node replay script (scripts/replay.ts) drives the
 * same plan over a real room when you want to measure real transport.
 */

import type { PlaybackClock } from "./clock.ts";
import { classifyValue, type FrameResult } from "./frames.ts";
import { messagesFromFixture, planReplay, type ReplayOptions, type ReplayPlan } from "./replay-plan.ts";
import { renderPcm, wrapWav } from "./tone.ts";

export interface LocalReplayEvents {
  onFrame(result: FrameResult, from: string): void;
  onLog(message: string, tone: "info" | "warn" | "error"): void;
  onFinished(): void;
}

export class LocalReplay {
  private readonly clock: PlaybackClock;
  private readonly events: LocalReplayEvents;
  private plan: ReplayPlan | null = null;
  private cursor = 0;
  private blobUrl: string | null = null;
  private running = false;

  constructor(clock: PlaybackClock, events: LocalReplayEvents) {
    this.clock = clock;
    this.events = events;
  }

  get active(): boolean {
    return this.running;
  }

  async start(fixtureName: string, options: ReplayOptions): Promise<void> {
    this.stop();

    const res = await fetch(`/api/fixtures/${encodeURIComponent(fixtureName)}`);
    if (!res.ok) throw new Error(`could not load fixture ${fixtureName} (${res.status})`);
    const plan = planReplay(messagesFromFixture(await res.json()), options);
    this.plan = plan;
    this.cursor = 0;

    const wav = wrapWav(renderPcm({ durationMs: plan.durationMs, cueMs: plan.cueMarksMs }));
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = URL.createObjectURL(new Blob([wav as BlobPart], { type: "audio/wav" }));

    const el = this.clock.el;
    el.srcObject = null;
    el.src = this.blobUrl;
    el.currentTime = 0;
    await el.play();
    this.clock.markAttached("local-file");
    this.running = true;

    this.events.onLog(
      `Local replay: ${fixtureName} — ${plan.frames.length} frames over ${Math.round(
        plan.durationMs,
      )}ms of generated audio (${options.mode ?? "burst"} delivery` +
        `${options.jitterMs ? `, up to ${options.jitterMs}ms jitter` : ""}). ` +
        "Each cue time is marked with an audible blip.",
      "info",
    );
  }

  /** Called from the main rAF loop, so delivery is clocked off playback too. */
  pump(): void {
    if (!this.running || !this.plan) return;
    const pos = this.clock.positionMs;

    while (this.cursor < this.plan.frames.length && this.plan.frames[this.cursor].deliverAtMs <= pos) {
      const frame = this.plan.frames[this.cursor++];
      this.events.onFrame(classifyValue(frame.message), "local-replay");
    }

    if (this.cursor >= this.plan.frames.length && (this.clock.el.ended || pos >= this.plan.durationMs)) {
      this.running = false;
      this.events.onLog("Local replay finished.", "info");
      this.events.onFinished();
    }
  }

  stop(): void {
    this.running = false;
    this.plan = null;
    this.cursor = 0;
    if (!this.clock.el.paused) this.clock.el.pause();
  }
}
