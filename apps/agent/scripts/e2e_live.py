"""End-to-end live-session check, no human required.

Joins a real LiveKit room as a fake learner, plays one or more question WAVs
through a published microphone track, and asserts the two things a tutoring
answer is made of:

  1. VOICE — remote audio frames with actual energy, from the worker's own
     track or from the avatar participant that republishes on its behalf
     (tallied per identity so a silent avatar is distinguishable from a
     silent agent).
  2. WHITEBOARD — `canvas_action` frames on the "canvas" data topic
     (present_visual / reveal_step with integer cueMs).

The room is minted by POSTing the same /api/live/session endpoint the browser
uses, so the bootstrap path is exercised too.

Usage:
    set -a && . ../../.env.local && set +a
    uv run python scripts/e2e_live.py --session-url http://localhost:5174 \
        --wav /tmp/niko-question.wav [--wav /tmp/followup.wav] --persona nico

Exit code 0 iff every WAV got both voice and (for the first WAV) whiteboard
actions. Prints a JSON verdict on the last line for machine consumption.
"""

from __future__ import annotations

import argparse
import array
import asyncio
import json
import sys
import time
import traceback
import wave

import httpx
from livekit import rtc

SAMPLE_RATE = 48_000
CHUNK_MS = 20
# int16 amplitude above which a frame counts as voiced. Speech peaks are in
# the thousands; comfort noise and silence sit far below.
VOICED_AMPLITUDE = 500


class Collector:
    """Everything observed in the room, tallied as it arrives."""

    def __init__(self) -> None:
        self.canvas_frames: list[dict] = []
        self.voiced_ms: dict[str, float] = {}
        self.cancelled_turns: list[str] = []
        self._tasks: list[asyncio.Task] = []

    def on_data(self, packet: rtc.DataPacket) -> None:
        if packet.topic != "canvas":
            return
        try:
            message = json.loads(packet.data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return
        if message.get("type") == "canvas_action":
            self.canvas_frames.append(message)
        elif message.get("type") == "cancel_turn":
            self.cancelled_turns.append(message.get("turnId", "?"))

    def watch_audio(self, track: rtc.Track, identity: str) -> None:
        self._tasks.append(asyncio.create_task(self._tally(track, identity)))

    async def _tally(self, track: rtc.Track, identity: str) -> None:
        stream = rtc.AudioStream(track)
        frames = 0
        top_peak = 0
        try:
            async for event in stream:
                frame = event.frame
                samples = array.array("h")
                samples.frombytes(bytes(frame.data))
                peak = max((abs(s) for s in samples), default=0)
                frames += 1
                top_peak = max(top_peak, peak)
                if frames == 1 or frames % 500 == 0:
                    print(
                        f"[e2e] audio {identity}: {frames} frames, peak so far {top_peak}",
                        flush=True,
                    )
                if peak > VOICED_AMPLITUDE:
                    ms = frame.samples_per_channel / frame.sample_rate * 1000
                    self.voiced_ms[identity] = self.voiced_ms.get(identity, 0.0) + ms
        except Exception:
            print(f"[e2e] audio tally for {identity} DIED:", flush=True)
            traceback.print_exc()
        finally:
            await stream.aclose()

    def action_counts(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for frame in self.canvas_frames:
            name = (frame.get("action") or {}).get("type", "?")
            counts[name] = counts.get(name, 0) + 1
        return counts


async def publish_wav(source: rtc.AudioSource, path: str) -> float:
    """Push one WAV through the mic source in real time. Returns duration s."""
    src = wave.open(path, "rb")
    assert src.getframerate() == SAMPLE_RATE and src.getnchannels() == 1, (
        f"{path}: need {SAMPLE_RATE}Hz mono, got "
        f"{src.getframerate()}Hz x{src.getnchannels()}"
    )
    samples_per_chunk = SAMPLE_RATE * CHUNK_MS // 1000
    total = src.getnframes() / SAMPLE_RATE
    started = time.monotonic()
    sent = 0
    while True:
        data = src.readframes(samples_per_chunk)
        if not data:
            break
        if len(data) < samples_per_chunk * 2:
            data = data + b"\x00" * (samples_per_chunk * 2 - len(data))
        await source.capture_frame(
            rtc.AudioFrame(
                data=data,
                sample_rate=SAMPLE_RATE,
                num_channels=1,
                samples_per_channel=samples_per_chunk,
            )
        )
        sent += CHUNK_MS / 1000
        # Pace to real time (with 200ms of prebuffer) — STT consumes live audio.
        ahead = sent - (time.monotonic() - started) - 0.2
        if ahead > 0:
            await asyncio.sleep(ahead)
    src.close()
    return total


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-url", default="http://localhost:5173")
    parser.add_argument("--persona", default="nico")
    parser.add_argument("--wav", action="append", required=True)
    parser.add_argument("--settle", type=float, default=25.0,
                        help="seconds to keep listening after the last wav")
    parser.add_argument("--min-voiced-ms", type=float, default=2000.0)
    args = parser.parse_args()

    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"{args.session_url}/api/live/session",
            json={"personaId": args.persona},
            timeout=15.0,
        )
        res.raise_for_status()
        session = res.json()
    print(f"[e2e] session minted: room={session.get('room')}", flush=True)

    room = rtc.Room()
    collector = Collector()
    agent_joined = asyncio.Event()

    @room.on("participant_connected")
    def _joined(participant: rtc.RemoteParticipant) -> None:
        print(f"[e2e] participant joined: {participant.identity}", flush=True)
        agent_joined.set()

    @room.on("track_subscribed")
    def _subscribed(
        track: rtc.Track,
        publication: rtc.TrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        print(
            f"[e2e] track subscribed: {participant.identity} kind={track.kind} "
            f"sid={track.sid} name={publication.name}",
            flush=True,
        )
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            collector.watch_audio(track, f"{participant.identity}/{track.sid}")

    @room.on("track_unsubscribed")
    def _unsubscribed(
        track: rtc.Track,
        publication: rtc.TrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        print(
            f"[e2e] track UNsubscribed: {participant.identity} sid={track.sid}",
            flush=True,
        )

    @room.on("data_received")
    def _data(packet: rtc.DataPacket) -> None:
        collector.on_data(packet)

    await room.connect(session["url"], session["token"])
    print("[e2e] connected as learner", flush=True)

    if not room.remote_participants:
        try:
            await asyncio.wait_for(agent_joined.wait(), timeout=30.0)
        except asyncio.TimeoutError:
            print(json.dumps({"ok": False, "reason": "agent never joined the room"}))
            await room.disconnect()
            return 1
    else:
        agent_joined.set()

    # Give the worker a beat to sweep tracks / attach STT before speaking.
    await asyncio.sleep(2.0)

    source = rtc.AudioSource(SAMPLE_RATE, 1)
    track = rtc.LocalAudioTrack.create_audio_track("learner-mic", source)
    await room.local_participant.publish_track(
        track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    )
    await asyncio.sleep(1.0)

    per_wav: list[dict] = []
    for wav_path in args.wav:
        before_voiced = sum(collector.voiced_ms.values())
        before_actions = len(collector.canvas_frames)
        print(f"[e2e] speaking: {wav_path}", flush=True)
        duration = await publish_wav(source, wav_path)
        print(f"[e2e] done speaking ({duration:.1f}s inc. padding)", flush=True)
        per_wav.append(
            {
                "wav": wav_path,
                "voiced_before_ms": before_voiced,
                "actions_before": before_actions,
            }
        )

    print(f"[e2e] settling {args.settle:.0f}s to collect the tail", flush=True)

    async def keep_mic_silent() -> None:
        # A stopped mic isn't silence — the VAD needs actual quiet frames to
        # finalize the turn, and STT needs a live stream while we listen.
        samples = SAMPLE_RATE * CHUNK_MS // 1000
        quiet = b"\x00" * (samples * 2)
        while True:
            await source.capture_frame(
                rtc.AudioFrame(
                    data=quiet,
                    sample_rate=SAMPLE_RATE,
                    num_channels=1,
                    samples_per_channel=samples,
                )
            )
            await asyncio.sleep(CHUNK_MS / 1000)

    keeper = asyncio.create_task(keep_mic_silent())
    await asyncio.sleep(args.settle)
    keeper.cancel()

    counts = collector.action_counts()
    total_voiced = sum(collector.voiced_ms.values())
    for entry in per_wav:
        entry["voiced_after_ms"] = total_voiced
    verdict = {
        "ok": (
            counts.get("present_visual", 0) >= 1
            and counts.get("reveal_step", 0) >= 1
            and total_voiced >= args.min_voiced_ms
        ),
        "voiced_ms_by_identity": {k: round(v) for k, v in collector.voiced_ms.items()},
        "canvas_actions": counts,
        "canvas_frames": len(collector.canvas_frames),
        "cancelled_turns": collector.cancelled_turns,
        "cue_ms_all_ints": all(
            isinstance(f.get("cueMs"), int) for f in collector.canvas_frames
        ),
        "turns_seen": sorted({f.get("turnId", "?") for f in collector.canvas_frames}),
    }
    await room.disconnect()
    print(json.dumps(verdict))
    return 0 if verdict["ok"] else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
