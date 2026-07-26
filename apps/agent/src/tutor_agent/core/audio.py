"""PCM framing for the publish path.

Two problems this solves, both of which only appear against a real transport.

**Sample alignment.** ElevenLabs streams PCM chunked on network boundaries, not
sample boundaries, so a chunk can end mid-sample and carry an odd byte count.
`rtc.AudioFrame` rejects that outright::

    ValueError: data length must be a multiple of sizeof(int16)

which raises inside `send_audio`, unwinds through the turn, and kills the reply.
The fakes never trip it because an in-memory adapter just appends bytes. So the
splitter carries the odd trailing byte forward into the next chunk instead.

**Barge-in granularity.** `AudioSource.clear_queue()` drops whole queued frames;
it cannot cut one in half. Hand the transport a single five-second frame and the
learner keeps hearing all five seconds after interrupting. Fixed 20ms frames put
a hard ceiling on how much already-committed audio survives an interruption.

Nothing here imports LiveKit — the messaging and phone adapters need the same
framing, and this stays testable offline.
"""

from __future__ import annotations

from collections.abc import Iterator

BYTES_PER_SAMPLE = 2
"""16-bit signed PCM. Every provider in the stack speaks this."""

DEFAULT_FRAME_MS = 20
"""LiveKit's native cadence. Also the worst-case audio that outlives a barge-in."""


class PcmStreamSplitter:
    """Reframes an arbitrarily-chunked PCM stream into fixed, aligned frames.

    Stateful and single-stream: one instance per audio sink, living as long as
    the connection, because the remainder from one segment belongs to the next.
    Speech is continuous across sentences — padding at every segment boundary
    would stutter it.
    """

    def __init__(
        self,
        *,
        sample_rate: int,
        num_channels: int = 1,
        frame_ms: int = DEFAULT_FRAME_MS,
    ) -> None:
        if sample_rate <= 0:
            raise ValueError(f"sample_rate must be positive, got {sample_rate}")
        if num_channels <= 0:
            raise ValueError(f"num_channels must be positive, got {num_channels}")
        if frame_ms <= 0:
            raise ValueError(f"frame_ms must be positive, got {frame_ms}")

        self.sample_rate = sample_rate
        self.num_channels = num_channels
        self.frame_ms = frame_ms

        samples_per_frame = sample_rate * frame_ms // 1000
        if samples_per_frame <= 0:
            raise ValueError(
                f"frame_ms={frame_ms} is below one sample at {sample_rate}Hz"
            )
        self.samples_per_frame = samples_per_frame
        self.bytes_per_frame = samples_per_frame * num_channels * BYTES_PER_SAMPLE

        self._pending = bytearray()

    @property
    def pending_bytes(self) -> int:
        """Buffered bytes not yet emitted. Never exceeds one frame."""
        return len(self._pending)

    def feed(self, audio: bytes) -> Iterator[bytes]:
        """Yield every whole frame available, holding the remainder back.

        Each yielded block is exactly `bytes_per_frame` long, so it is aligned
        by construction — the caller never has to check.
        """
        if audio:
            self._pending.extend(audio)
        while len(self._pending) >= self.bytes_per_frame:
            frame = bytes(self._pending[: self.bytes_per_frame])
            del self._pending[: self.bytes_per_frame]
            yield frame

    def flush(self) -> bytes | None:
        """Emit the tail at end of speech, or None if there is nothing left.

        Padded up to a whole sample, never up to a whole frame: a partial frame
        is legal and a full one would append audible silence to every turn. The
        pad is at most one byte.
        """
        if not self._pending:
            return None
        tail = bytes(self._pending)
        self._pending.clear()
        remainder = len(tail) % BYTES_PER_SAMPLE
        if remainder:
            tail += b"\x00" * (BYTES_PER_SAMPLE - remainder)
        return tail

    def reset(self) -> None:
        """Drop the buffered tail without emitting it.

        This is the barge-in path: the learner interrupted, so a fragment of the
        abandoned sentence must not be prepended to the next one.
        """
        self._pending.clear()
