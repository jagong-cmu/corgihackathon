/**
 * Fixture replay over a real LiveKit room.
 *
 * Joins as a publisher, puts up an audio track, and sends the fixture's frames
 * on the data channel at their planned offsets into that audio — i.e. it
 * stands in for the agent worker so the inspector has something to measure
 * before adapters/realtime.py exists.
 *
 *   npm run replay -w @tutor/cue-inspector -- --fixture worked-quadratic
 *   npm run replay -w @tutor/cue-inspector -- --fixture collision-newton-third --barge-in 5000
 *   npm run replay -w @tutor/cue-inspector -- --fixture worked-quadratic --dry-run
 *
 * `--dry-run` prints the plan and exits without touching the network, so the
 * expected cueMs for a fixture can be checked with no credentials at all.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";
import { messagesFromFixture, planReplay, type DeliveryMode } from "../src/replay-plan.ts";
import { SAMPLE_RATE, renderPcm } from "../src/tone.ts";
import { MissingCredentialsError, liveKitCredentials, repoRoot } from "./env.ts";

const FIXTURE_DIR = join(repoRoot(), "packages", "canvas-protocol", "test", "fixtures");

/** Audio captured this far ahead of playout, so the pipeline never starves. */
const PREBUFFER_MS = 200;
const CHUNK_MS = 20;

interface Args {
  fixture: string;
  room: string;
  identity: string;
  mode: DeliveryMode;
  jitterMs: number;
  bargeInAtMs?: number;
  dryRun: boolean;
  waitForSubscriber: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    fixture: "worked-quadratic",
    room: "cue-inspector",
    identity: "tutor-replay",
    mode: "burst",
    jitterMs: 0,
    dryRun: false,
    waitForSubscriber: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--fixture": args.fixture = value(); break;
      case "--room": args.room = value(); break;
      case "--identity": args.identity = value(); break;
      case "--mode": args.mode = value() as DeliveryMode; break;
      case "--jitter": args.jitterMs = Number(value()); break;
      case "--barge-in": args.bargeInAtMs = Number(value()); break;
      case "--dry-run": args.dryRun = true; break;
      case "--no-wait": args.waitForSubscriber = false; break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
      // falls through
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }

  if (args.mode !== "burst" && args.mode !== "streamed") {
    throw new Error(`--mode must be burst or streamed, got ${args.mode}`);
  }
  return args;
}

function usage(): void {
  const available = existsSync(FIXTURE_DIR)
    ? readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""))
    : [];
  console.log(`
cue-inspector replay — publishes a fixture into a LiveKit room as if it were the agent.

  --fixture <name|path>   fixture to replay (default worked-quadratic)
  --room <name>           room to join (default cue-inspector)
  --identity <name>       publisher identity (default tutor-replay)
  --mode burst|streamed   burst sends a turn's frames together at its start, as
                          the agent does; streamed sends each near its cue time
  --jitter <ms>           extra delivery lateness per frame, streamed mode
  --barge-in <ms>         retime the fixture's cancel_turn to this offset into
                          its turn, so it cancels cues that haven't fired yet
  --no-wait               start immediately instead of waiting for a subscriber
  --dry-run               print the plan and exit; no network, no credentials

fixtures on disk: ${available.join(", ") || "none found"}
`);
}

function loadFixture(nameOrPath: string): { name: string; messages: unknown[] } {
  const path = nameOrPath.endsWith(".json") ? nameOrPath : join(FIXTURE_DIR, `${nameOrPath}.json`);
  if (!existsSync(path)) throw new Error(`no fixture at ${path}`);
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  return { name: nameOrPath, messages: messagesFromFixture(fixture) };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { name, messages } = loadFixture(args.fixture);
  const plan = planReplay(messages, {
    mode: args.mode,
    jitterMs: args.jitterMs,
    bargeInAtMs: args.bargeInAtMs,
  });

  console.log(
    `\n${name}: ${plan.frames.length} frames, ${plan.cueMarksMs.length} cues, ` +
      `${Math.round(plan.durationMs)}ms of audio, ${args.mode} delivery` +
      `${args.jitterMs ? ` with up to ${args.jitterMs}ms jitter` : ""}.\n`,
  );
  printPlan(plan.frames);

  if (args.dryRun) {
    console.log("\n--dry-run: nothing published.\n");
    return;
  }

  let creds;
  try {
    creds = liveKitCredentials();
  } catch (err) {
    if (err instanceof MissingCredentialsError) {
      console.error(`\n${err.message}\n\nRun with --dry-run to check the plan without credentials.\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const at = new AccessToken(creds.apiKey, creds.apiSecret, { identity: args.identity, ttl: "1h" });
  at.addGrant({ roomJoin: true, room: args.room, canPublish: true, canPublishData: true, canSubscribe: true });

  const room = new Room();
  room.on(RoomEvent.ParticipantConnected, (p) => console.log(`  ← ${p.identity} joined`));
  room.on(RoomEvent.Disconnected, () => console.log("  disconnected"));

  console.log(`connecting to ${creds.url} as ${args.identity} in ${args.room}…`);
  await room.connect(creds.url, await at.toJwt(), { autoSubscribe: false, dynacast: false });

  const source = new AudioSource(SAMPLE_RATE, 1);
  const track = LocalAudioTrack.createAudioTrack("tutor-voice", source);
  await room.localParticipant!.publishTrack(
    track,
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
  );
  console.log("published audio track");

  if (args.waitForSubscriber) await waitForSubscriber(room);

  const pcm = renderPcm({ durationMs: plan.durationMs, cueMs: plan.cueMarksMs });
  await pump(room, source, pcm, plan.frames);

  await source.waitForPlayout();
  await room.disconnect();
  console.log("\nreplay complete.\n");
}

/**
 * Give the inspector a chance to join first. Its playback clock starts when it
 * attaches the track, so publishing into an empty room means the first turn's
 * audio is already over before anyone is listening.
 */
async function waitForSubscriber(room: Room, timeoutMs = 60_000): Promise<void> {
  if (room.remoteParticipants.size > 0) return;
  console.log("waiting for a subscriber (--no-wait to skip)…");
  await new Promise<void>((resolve) => {
    const done = () => {
      globalThis.clearTimeout(timer);
      globalThis.clearInterval(poll);
      room.off(RoomEvent.ParticipantConnected, done);
      resolve();
    };
    const timer = globalThis.setTimeout(() => {
      console.log("  no subscriber after 60s — starting anyway");
      done();
    }, timeoutMs);
    // Poll as well as listen. A participant who was already in the room when
    // we connected fires no ParticipantConnected event, and the roster is not
    // populated synchronously when connect() resolves — waiting on the event
    // alone hangs for the full timeout in the most common case of all, which
    // is the inspector being open before you start the replay.
    const poll = globalThis.setInterval(() => {
      if (room.remoteParticipants.size > 0) done();
    }, 200);
    room.on(RoomEvent.ParticipantConnected, done);
  });
  // Let the subscriber finish negotiating before the first cue goes out.
  await sleep(500);
}

/**
 * Capture audio in real time and publish each frame when playout reaches its
 * planned offset.
 *
 * Audio is captured PREBUFFER_MS ahead of playout, so the wall-clock instant
 * at which sample X is *heard* is t0 + X. Data frames are published against
 * that same t0, which is what makes the offsets in the plan mean "into this
 * turn's audio" on the receiving end.
 */
async function pump(
  room: Room,
  source: AudioSource,
  pcm: Int16Array,
  frames: { deliverAtMs: number; message: unknown; label: string }[],
): Promise<void> {
  const samplesPerChunk = (SAMPLE_RATE * CHUNK_MS) / 1000;
  const encoder = new TextEncoder();
  const t0 = performance.now();
  let cursor = 0;
  let offset = 0;

  console.log("\n  playout      frame");
  while (offset < pcm.length) {
    const end = Math.min(offset + samplesPerChunk, pcm.length);
    // Copy, don't subarray: AudioFrame.protoInfo() sends the whole underlying
    // ArrayBuffer, so a view would ship the entire track on every frame.
    const chunk = new Int16Array(pcm.subarray(offset, end));
    const capturedMs = (end / SAMPLE_RATE) * 1000;

    const dueAt = capturedMs - PREBUFFER_MS;
    const behind = dueAt - (performance.now() - t0);
    if (behind > 0) await sleep(behind);

    await source.captureFrame(new AudioFrame(chunk, SAMPLE_RATE, 1, chunk.length));
    offset = end;

    const playoutMs = performance.now() - t0;
    while (cursor < frames.length && frames[cursor].deliverAtMs <= playoutMs) {
      const frame = frames[cursor++];
      await room.localParticipant!.publishData(encoder.encode(JSON.stringify(frame.message)), {
        reliable: true,
        topic: "canvas",
      });
      console.log(`  ${pad(Math.round(playoutMs), 6)}ms     → ${frame.label}`);
    }
  }

  // Anything left (frames planned past the end of the audio) goes out now.
  for (; cursor < frames.length; cursor++) {
    await room.localParticipant!.publishData(
      encoder.encode(JSON.stringify(frames[cursor].message)),
      { reliable: true, topic: "canvas" },
    );
    console.log(`  ${pad(Math.round(performance.now() - t0), 6)}ms     → ${frames[cursor].label} (tail)`);
  }
}

function printPlan(frames: { deliverAtMs: number; label: string }[]): void {
  console.log("  deliver at   frame");
  for (const frame of frames) {
    console.log(`  ${pad(Math.round(frame.deliverAtMs), 6)}ms     ${frame.label}`);
  }
}

const pad = (n: number, width: number) => String(n).padStart(width, " ");

main().catch((err) => {
  console.error(`\nreplay failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
