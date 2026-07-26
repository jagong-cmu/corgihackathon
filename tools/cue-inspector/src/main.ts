/**
 * Wiring. Everything with an opinion lives in its own module:
 *
 *   frames.ts       validation boundary (@tutor/canvas-protocol, nothing local)
 *   clock.ts        playback position from <audio>.currentTime, never Date.now
 *   cue-queue.ts    cues keyed to that position, cancellation, drift
 *   transport.ts    LiveKit subscribe-only join
 *   local-replay.ts fixtures + generated audio, no credentials
 *   table.ts        the live table
 */

import { PlaybackClock } from "./clock.ts";
import { CueQueue, type CueRow, type TurnState } from "./cue-queue.ts";
import type { FrameResult } from "./frames.ts";
import { classifyText, classifyValue } from "./frames.ts";
import { LocalReplay } from "./local-replay.ts";
import type { DeliveryMode } from "./replay-plan.ts";
import { CueTable } from "./table.ts";
import { LiveKitTransport } from "./transport.ts";

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
};

const audio = el<HTMLAudioElement>("audio");
const logPanel = el("log");
const statusPill = el("status");
const clockPos = el("clock-pos");
const clockSource = el("clock-source");

const clock = new PlaybackClock(audio);
const table = new CueTable(el("table-root"), el("summary"), el("turns"));

let dirty = true;

function log(message: string, tone: "info" | "warn" | "error" = "info"): void {
  const line = document.createElement("div");
  line.className = tone;
  const stamp = document.createElement("time");
  // Wall-clock, for the log only. Nothing measured is ever timed off this.
  stamp.textContent = new Date().toLocaleTimeString([], { hour12: false });
  line.append(stamp, document.createTextNode(message));
  logPanel.append(line);
  logPanel.scrollTop = logPanel.scrollHeight;
}

const queue = new CueQueue(clock, {
  onRowAdded: (row: CueRow) => {
    table.addRow(row);
    dirty = true;
  },
  onRowChanged: (row: CueRow) => {
    table.updateRow(row);
    dirty = true;
  },
  onTurnChanged: (_turn: TurnState) => {
    dirty = true;
  },
  onWarning: (message: string) => log(message, "warn"),
});

/** Single entry point for every inbound frame, whatever produced it. */
function handleFrame(result: FrameResult, from: string): void {
  switch (result.kind) {
    case "agent":
      queue.accept(result.message);
      return;
    case "client":
      // Valid, but travelling the other way — the fixtures interleave
      // student_events. Noted, not counted as an error.
      log(`ignored ${result.message.type} from ${from} (client → agent frame)`, "info");
      return;
    case "invalid":
      // §13 says the product client drops these silently and logs them. This
      // tool is the log, so it shouts instead.
      log(`DROPPED invalid frame from ${from}: ${result.reason} — ${result.text}`, "error");
      return;
  }
}

const transport = new LiveKitTransport(clock, {
  onFrame: handleFrame,
  onStatus: (status, tone) => {
    statusPill.textContent = status;
    statusPill.className = `status ${tone}`;
  },
  onLog: log,
});

const replay = new LocalReplay(clock, {
  onFrame: handleFrame,
  onLog: log,
  onFinished: () => {
    el<HTMLButtonElement>("replay").disabled = false;
    el<HTMLButtonElement>("stop-replay").disabled = true;
  },
});

// ---------------------------------------------------------------------------
// The tick loop. Cues fire here, off the playback clock, once per frame.
// ---------------------------------------------------------------------------

function tick(): void {
  replay.pump();
  queue.tick();

  const pos = clock.positionMs;
  clockPos.textContent = `${Math.round(pos)} ms`;
  clockSource.textContent =
    clock.kind === "none" ? "no clock" : `${clock.kind}${clock.playing ? "" : " (paused)"}`;

  if (dirty) {
    table.renderSummary(queue.allRows);
    table.renderTurns(queue.turnStates);
    dirty = false;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

el<HTMLButtonElement>("connect").addEventListener("click", async () => {
  const button = el<HTMLButtonElement>("connect");
  button.disabled = true;
  try {
    await transport.connect(el<HTMLInputElement>("room-name").value.trim() || "cue-inspector");
    el<HTMLButtonElement>("disconnect").disabled = false;
  } catch (err) {
    log(`connect failed: ${(err as Error).message}`, "error");
    button.disabled = false;
  }
});

el<HTMLButtonElement>("disconnect").addEventListener("click", async () => {
  await transport.disconnect();
  el<HTMLButtonElement>("connect").disabled = false;
  el<HTMLButtonElement>("disconnect").disabled = true;
});

el<HTMLButtonElement>("replay").addEventListener("click", async () => {
  const bargeInRaw = el<HTMLInputElement>("barge-in").value;
  try {
    el<HTMLButtonElement>("replay").disabled = true;
    await replay.start(el<HTMLSelectElement>("fixture").value, {
      mode: el<HTMLSelectElement>("mode").value as DeliveryMode,
      jitterMs: Number(el<HTMLInputElement>("jitter").value) || 0,
      bargeInAtMs: bargeInRaw === "" ? undefined : Number(bargeInRaw),
    });
    el<HTMLButtonElement>("stop-replay").disabled = false;
  } catch (err) {
    log(`replay failed: ${(err as Error).message}`, "error");
    el<HTMLButtonElement>("replay").disabled = false;
  }
});

el<HTMLButtonElement>("stop-replay").addEventListener("click", () => {
  replay.stop();
  el<HTMLButtonElement>("replay").disabled = false;
  el<HTMLButtonElement>("stop-replay").disabled = true;
});

el<HTMLButtonElement>("clear").addEventListener("click", () => {
  queue.reset();
  table.clear();
  table.renderSummary([]);
});

/**
 * Malformed frames. Every one of these is something a buggy agent could
 * plausibly emit, and none of them may take the tool down.
 */
el<HTMLButtonElement>("malformed").addEventListener("click", () => {
  log("injecting malformed frames — none of these should reach the table", "warn");

  handleFrame(classifyText("{ not json at all"), "malformed-test");
  handleFrame(classifyText("null"), "malformed-test");
  handleFrame(classifyValue({ type: "canvas_action" }), "malformed-test");
  handleFrame(classifyValue({ type: "wat", turnId: "t_0001" }), "malformed-test");
  handleFrame(
    // turnId that doesn't match ^t_\d{4,}$
    classifyValue({ type: "canvas_action", turnId: "42", seq: 0, cueMs: 0, action: { type: "new_section", title: "x" } }),
    "malformed-test",
  );
  handleFrame(
    // negative cueMs
    classifyValue({ type: "canvas_action", turnId: "t_9001", seq: 0, cueMs: -5, action: { type: "new_section", title: "x" } }),
    "malformed-test",
  );
  handleFrame(
    // unknown action type
    classifyValue({ type: "canvas_action", turnId: "t_9001", seq: 1, cueMs: 10, action: { type: "teleport", x: 1 } }),
    "malformed-test",
  );
  handleFrame(
    // The cross-field rule JSON Schema can't express: op 'speed' needs a value.
    classifyValue({
      type: "canvas_action",
      turnId: "t_9001",
      seq: 2,
      cueMs: 20,
      action: { type: "sim_control", id: "sim_collision", op: "speed" },
    }),
    "malformed-test",
  );
  handleFrame(
    // Valid envelope, valid action — the control case. This one must land.
    classifyValue({
      type: "canvas_action",
      turnId: "t_9001",
      seq: 3,
      cueMs: 0,
      action: { type: "new_section", title: "malformed-frame control row" },
    }),
    "malformed-test",
  );
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

audio.addEventListener("pause", () => {
  if (clock.kind !== "none") log("Playback paused — the clock is frozen, cues will not fire.", "warn");
});

void (async () => {
  try {
    const res = await fetch("/api/fixtures");
    const { fixtures } = (await res.json()) as { fixtures: string[] };
    const select = el<HTMLSelectElement>("fixture");
    for (const name of fixtures) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.append(option);
    }
    log(`Ready. ${fixtures.length} fixtures available: ${fixtures.join(", ")}.`, "info");
  } catch (err) {
    log(`could not list fixtures: ${(err as Error).message}`, "error");
  }
})();

table.renderSummary([]);
