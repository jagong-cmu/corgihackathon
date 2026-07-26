# cue-inspector

A debug client that answers one question: **do canvas actions land on the words
they belong to?**

It joins a LiveKit room as a subscriber, plays the tutor's audio, validates
every data-channel frame against `@tutor/canvas-protocol`, and shows each
`canvas_action`'s intended `cueMs` next to the audio playback position it
actually fired at.

**This is a throwaway harness, not the product.** It renders no canvas — the
real whiteboard is the app at the repo root. It stayed useful after that
client landed for two reasons: it shows drift as a *table* of every cue rather
than the latest one, and `scripts/replay.ts` publishes a fixture into a room as
if it were the agent, which is how you work on the board without burning STT,
model, and TTS calls on every reload.

```bash
# Join a lesson in the app first, then push a recorded turn into its room.
npm run replay -w @tutor/cue-inspector -- --fixture worked-quadratic --room <room>
```

The room name is shown in the app once connected. Join before starting the
replay: frames are not redelivered to a late joiner.

`src/cue-queue.ts` was the prototype for `src/live/cueQueue.ts` in the client.
They have diverged — the client applies actions to a board instead of appending
rows — but the turn-origin inference and the ordering rules are the same, and a
fix to one is worth checking against the other.

```bash
npm install                      # from the repo root
npm run dev -w @tutor/cue-inspector
open http://localhost:5178
```

## Two ways to get frames into it

**Local replay (no credentials).** Pick a fixture, press *run local replay*. It
generates a WAV covering the whole session, plays it through the same
`<audio>` element, and delivers the fixture's frames against that playback. Each
cue time gets an audible blip, so drift is something you can hear as well as
read.

**A real room.** Put credentials in `.env.local` at the repo root (gitignored):

```
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

Press *connect*, then publish something into that room — the agent worker once
`adapters/realtime.py` exists, or the replay script until then:

```bash
npm run replay -w @tutor/cue-inspector -- --fixture worked-quadratic
npm run replay -w @tutor/cue-inspector -- --fixture collision-newton-third --barge-in 5000
npm run replay -w @tutor/cue-inspector -- --fixture worked-quadratic --dry-run   # plan only, no network
```

The script joins as a publisher, puts up a real audio track, and sends the
fixture's frames at their offsets into it. It waits for a subscriber first, so
open the inspector before you start it (`--no-wait` to skip).

Secrets stay in Node. The browser never sees a key — the dev server mints a
subscribe-only JWT at `/api/token` and hands back a URL and a token.

No LiveKit Cloud project? `livekit-server --dev` works, with
`LIVEKIT_URL=ws://127.0.0.1:7880`, `devkey` / `secret`.

## Reading the table

| column | meaning |
|---|---|
| `cue ms` | what the agent asked for: offset into this turn's audio |
| `actual ms` | playback position when the cue actually fired |
| `drift ms` | `actual - cue`. Green under 50ms, amber under 150ms, red above |
| `arrived @` | playback position when the frame landed |

`arrived @` is the column that tells you *why* a row is red. If a frame arrived
after its own cue time, it was late on the wire and no client could have fired
it on time. If it arrived early and still drifted, the cost is in the client.

Cancelled rows stay in the table, struck through. That is the point: a dropped
row and a cue that was never sent look identical, and barge-in is a behaviour
you want to watch, not infer.

## Things worth knowing

**The clock is `HTMLAudioElement.currentTime`, never `Date.now()`.** A cue is
late if it lands after its words were *heard*. Wall-clock time hides exactly the
failures this tool exists to find: a stalled track freezes playback while
`Date.now()` sails on. The one exception is the "no audio is playing" warning,
which is a UI liveness check and is commented as such.

**Turn origins are inferred.** `cueMs` is relative to the start of its turn's
audio, but the audio is one continuous stream with no turn markers in it, so the
first frame of a turn pins the origin at `playbackPosition - cueMs`. Each turn's
inferred origin is shown in a chip above the table. If that anchor frame was
itself delivered late, the whole turn's drift is understated by the same amount,
and the client cannot detect it — under burst delivery every frame arrives at
once, so nothing contradicts a late anchor. The real client will do better,
because it knows locally when it started playing each turn.

**Delivery modes.** `burst` is what the agent actually does: cue times are only
known once TTS returns character timings, so a turn's frames go out together at
its start. Drift then measures the client's own poll granularity, which is the
healthy baseline. `streamed --jitter 400` delivers each frame near its own cue
time with added lateness, which is how you make amber and red appear on demand
and confirm the bands are wired up.

**Malformed frames.** *inject malformed frames* pushes eight bad frames plus one
good control row through the same path: broken JSON, `null`, a bad `turnId`, a
negative `cueMs`, an unknown action, and `sim_control` with `op: "speed"` and no
`value` — the cross-field rule JSON Schema cannot express, which only the Zod
refinement catches. All nine are logged; only the control row reaches the table.
§13 says the product client drops these silently. This tool is the log, so it
shouts instead.

## Layout

```
src/frames.ts        validation boundary — imports @tutor/canvas-protocol, defines nothing
src/clock.ts         playback position from <audio>.currentTime
src/cue-queue.ts     cues keyed to playback position, turn origins, cancellation, drift
src/transport.ts     LiveKit subscribe-only join
src/local-replay.ts  fixtures + generated audio, no credentials
src/replay-plan.ts   fixture messages -> a timed plan (shared with the Node script)
src/tone.ts          the synthetic audio, shared with the Node script
scripts/replay.ts    publishes a fixture into a real room
```

The message schemas are never redefined here. `safeParseAgentMessage()` from
`@tutor/canvas-protocol` is the only way a frame gets in, and the dev server
resolves that package to its TypeScript source rather than a built `dist`, so
changing the protocol breaks this tool immediately instead of at the next build.
