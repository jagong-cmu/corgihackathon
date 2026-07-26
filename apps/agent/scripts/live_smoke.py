"""Live end-to-end turn: real Claude, real ElevenLabs, real cue timing.

    set -a && . ./.env && set +a && uv run python scripts/live_smoke.py

Costs a few cents per run. Writes the synthesized audio to /tmp so you can
listen and check the actions land on the words the table claims they do.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path

from tutor_agent.core import RecordingAdapter, SessionConfig, TutorSession
from tutor_agent.persona import get_persona
from tutor_agent.providers.anthropic_llm import AnthropicLLM
from tutor_agent.providers.elevenlabs import ElevenLabsTTS

QUESTION = "I keep messing up factoring. Can you walk me through x squared minus four x plus three?"


class TimingTTS:
    """Wraps the real TTS so we can measure and keep the audio.

    Must proxy synthesize_stream as well as synthesize — a wrapper that only
    forwards the blocking call silently downgrades the session to the slow
    path, which is exactly the thing being measured.
    """

    def __init__(self, inner: ElevenLabsTTS) -> None:
        self.inner = inner
        self.first_audio_ms: float | None = None
        self.audio = bytearray()
        self.chunks = 0
        self._t0 = time.perf_counter()

    def _mark(self) -> None:
        if self.first_audio_ms is None:
            self.first_audio_ms = (time.perf_counter() - self._t0) * 1000

    async def synthesize(self, text: str, *, voice_id: str, model: str):
        result = await self.inner.synthesize(text, voice_id=voice_id, model=model)
        self._mark()
        self.audio.extend(result.audio)
        return result

    async def synthesize_stream(self, text: str, *, voice_id: str, model: str):
        async for chunk in self.inner.synthesize_stream(text, voice_id=voice_id, model=model):
            if chunk.audio:
                self._mark()
                self.audio.extend(chunk.audio)
                self.chunks += 1
            yield chunk


async def main() -> int:
    persona_id = sys.argv[1] if len(sys.argv) > 1 else "ada"
    if not os.environ.get("ELEVENLABS_API_KEY"):
        print("ELEVENLABS_API_KEY not set — did you source .env?", file=sys.stderr)
        return 1

    persona = get_persona(persona_id)
    assert persona.voice is not None

    tts = TimingTTS(ElevenLabsTTS(api_key=os.environ["ELEVENLABS_API_KEY"]))
    adapter = RecordingAdapter()
    session = TutorSession(
        persona=persona,
        llm=AnthropicLLM(model="claude-sonnet-5", effort="low"),
        tts=tts,
        channel=adapter,
        config=SessionConfig(),
    )

    print(f"persona: {persona.identity.name} ({persona.id})")
    print(f"student: {QUESTION}\n")

    t0 = time.perf_counter()
    result = await session.handle_transcript(QUESTION)
    total_ms = (time.perf_counter() - t0) * 1000

    print(f"{persona.identity.name}: {result.speech_text}\n")

    print("─" * 78)
    print(f"{'cue':>8}  {'seq':>3}  {'action':<14} lands on")
    print("─" * 78)
    for action in result.actions:
        print(
            f"{action.cue_ms:>7}ms  {action.seq:>3}  {action.action['type']:<14} "
            f"{_word_at(result.speech_text, action.cue_ms, tts)!r}"
        )
    print("─" * 78)

    print(f"\nturn total:      {total_ms:>7.0f}ms")
    if tts.first_audio_ms is not None:
        print(f"first audio at:  {tts.first_audio_ms:>7.0f}ms   (budget 1200ms)")
    print(f"frames emitted:  {len(adapter.frames):>7}")
    print(f"audio chunks:    {tts.chunks:>7}")
    print(f"dropped:         {len(result.dropped_actions):>7}")
    for name, errors in result.dropped_actions:
        print(f"    {name}: {'; '.join(errors)}")

    if tts.audio:
        out = Path("/tmp/tutor-smoke.pcm")
        out.write_bytes(bytes(tts.audio))
        print(f"\naudio -> {out}   (ffplay -f s16le -ar 48000 -ac 1 {out})")

    await tts.inner.aclose()
    return 1 if result.dropped_actions else 0


def _word_at(text: str, cue_ms: int, tts: TimingTTS) -> str:
    """Best-effort: which word is being spoken at cue_ms."""
    from tutor_agent.core.cue import synthetic_timings

    total = max(1, synthetic_timings(text).duration_ms)
    i = min(len(text) - 1, int(len(text) * cue_ms / total))
    return text[i : i + 28].split("\n")[0]


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
