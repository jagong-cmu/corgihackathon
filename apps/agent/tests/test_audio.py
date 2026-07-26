"""PCM reframing on the publish path.

The bug this exists to prevent is invisible offline: an in-memory adapter
accepts any byte string, so the whole suite passed while `send_audio` would
have raised on the first odd-length chunk a real ElevenLabs stream produced.
"""

from __future__ import annotations

import pytest

from tutor_agent.core.audio import BYTES_PER_SAMPLE, PcmStreamSplitter


def _splitter(**kwargs) -> PcmStreamSplitter:
    return PcmStreamSplitter(sample_rate=48_000, num_channels=1, **kwargs)


class TestFraming:
    def test_frame_size_matches_the_declared_duration(self):
        s = _splitter(frame_ms=20)
        assert s.samples_per_frame == 960
        assert s.bytes_per_frame == 1920

    def test_yields_whole_frames_only(self):
        s = _splitter()
        frames = list(s.feed(b"\x01\x02" * 960 * 3))
        assert len(frames) == 3
        assert all(len(f) == s.bytes_per_frame for f in frames)

    def test_holds_back_a_partial_frame(self):
        s = _splitter()
        assert list(s.feed(b"\x00" * 100)) == []
        assert s.pending_bytes == 100

    def test_partial_frames_accumulate_across_calls(self):
        s = _splitter()
        half = s.bytes_per_frame // 2
        assert list(s.feed(b"\x00" * half)) == []
        (frame,) = list(s.feed(b"\x00" * half))
        assert len(frame) == s.bytes_per_frame
        assert s.pending_bytes == 0


class TestSampleAlignment:
    """The live crash: `data length must be a multiple of sizeof(int16)`."""

    def test_odd_length_chunk_never_reaches_the_transport_unaligned(self):
        s = _splitter()
        for frame in s.feed(b"\x00" * (s.bytes_per_frame + 1)):
            assert len(frame) % BYTES_PER_SAMPLE == 0
        assert s.pending_bytes == 1

    def test_the_split_sample_is_rejoined_not_dropped(self):
        """A byte held back must reappear in the next frame, in order."""
        s = _splitter()
        first = bytes(range(256)) * 8  # 2048 bytes: one frame + 128 over
        list(s.feed(first))
        rest = b"\xaa" * (s.bytes_per_frame * 2)
        frames = list(s.feed(rest))

        recovered = b"".join(frames)
        # The 128-byte remainder of `first` leads the next frame.
        assert recovered.startswith(first[s.bytes_per_frame :])

    def test_no_bytes_are_lost_across_a_full_stream(self):
        s = _splitter()
        # Deliberately ragged chunk sizes, several of them odd.
        chunks = [b"\x11" * n for n in (1, 3, 1000, 7, 1921, 5, 63, 2)]
        out = b"".join(b"".join(s.feed(c)) for c in chunks)
        tail = s.flush() or b""
        total_in = sum(len(c) for c in chunks)
        # Only the single pad byte may be added, and only when the total is odd.
        assert len(out + tail) == total_in + (total_in % BYTES_PER_SAMPLE)


class TestFlush:
    def test_flush_returns_none_when_empty(self):
        assert _splitter().flush() is None

    def test_flush_pads_to_a_whole_sample_not_a_whole_frame(self):
        """Padding to a full frame would append silence to every turn."""
        s = _splitter()
        list(s.feed(b"\x00" * 101))
        tail = s.flush()
        assert tail is not None
        assert len(tail) == 102
        assert len(tail) < s.bytes_per_frame

    def test_flush_drains_the_buffer(self):
        s = _splitter()
        list(s.feed(b"\x00" * 50))
        s.flush()
        assert s.pending_bytes == 0
        assert s.flush() is None


class TestReset:
    def test_reset_discards_without_emitting(self):
        """Barge-in: a fragment of the abandoned sentence must not survive."""
        s = _splitter()
        list(s.feed(b"\x42" * 500))
        s.reset()
        assert s.pending_bytes == 0
        assert s.flush() is None

    def test_next_frame_after_reset_is_clean(self):
        s = _splitter()
        list(s.feed(b"\x42" * 500))
        s.reset()
        (frame,) = list(s.feed(b"\x07" * s.bytes_per_frame))
        assert frame == b"\x07" * s.bytes_per_frame


class TestConfiguration:
    def test_avatar_rate_produces_smaller_frames_than_the_publish_rate(self):
        assert (
            PcmStreamSplitter(sample_rate=16_000).bytes_per_frame
            < PcmStreamSplitter(sample_rate=48_000).bytes_per_frame
        )

    def test_stereo_doubles_the_frame(self):
        mono = PcmStreamSplitter(sample_rate=48_000, num_channels=1)
        stereo = PcmStreamSplitter(sample_rate=48_000, num_channels=2)
        assert stereo.bytes_per_frame == mono.bytes_per_frame * 2

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"sample_rate": 0},
            {"sample_rate": -48_000},
            {"sample_rate": 48_000, "num_channels": 0},
            {"sample_rate": 48_000, "frame_ms": 0},
        ],
    )
    def test_rejects_nonsense_configuration(self, kwargs):
        with pytest.raises(ValueError):
            PcmStreamSplitter(**kwargs)

    def test_rejects_a_frame_shorter_than_one_sample(self):
        with pytest.raises(ValueError, match="below one sample"):
            PcmStreamSplitter(sample_rate=100, frame_ms=1)
