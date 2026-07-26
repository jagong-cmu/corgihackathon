"""LemonSlice avatar sourcing: ref rules + blob photo loading.

The create-tutor flow stores the captured photo in the API's blob store, so the
persona's avatar_ref is `blob:<id>`. At session start the worker resolves that
to a PIL image and LemonSlice receives the bytes as a multipart upload — no
public URL anywhere. These tests pin the selection rules (exactly one source,
blob refs never leak to the vendor as bogus agent ids) and the loader.

The loader tests need a real database, same gate as test_retrieval_pg:

    cd infra && make up
    export TUTOR_TEST_DATABASE_URL=postgres://tutor:tutor@localhost:5432/tutor
"""

from __future__ import annotations

import os

import pytest

from tutor_agent.providers.livekit_avatar import (
    BLOB_REF_PREFIX,
    LemonSliceConfig,
    load_blob_image,
    select_lemonslice_source,
)

def _png_bytes() -> bytes:
    """A tiny real PNG — what a webcam capture reduces to for these tests."""
    import io

    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (2, 2), "white").save(buffer, format="PNG")
    return buffer.getvalue()


def _config(**kwargs) -> LemonSliceConfig:
    return LemonSliceConfig(api_key="k", **kwargs)


class TestSelectLemonSliceSource:
    """The plugin demands exactly one of agent_id / agent_image_url / agent_image."""

    def test_plain_ref_is_an_agent_id(self):
        assert select_lemonslice_source(_config(), "agent-123") == {"agent_id": "agent-123"}

    def test_http_ref_is_a_photo_url(self):
        for url in ("http://x/face.jpg", "https://x/face.jpg"):
            assert select_lemonslice_source(_config(), url) == {"agent_image_url": url}

    def test_blob_ref_needs_the_caller_to_resolve_it(self):
        """An unresolved blob ref must not reach LemonSlice as an agent id."""
        assert select_lemonslice_source(_config(), f"{BLOB_REF_PREFIX}abc") is None

    def test_blob_ref_with_resolved_image_uses_the_image(self):
        image = object()  # the selection logic never touches the image itself
        got = select_lemonslice_source(_config(agent_image=image), f"{BLOB_REF_PREFIX}abc")
        assert got == {"agent_image": image}

    def test_persona_ref_overrides_every_config_source(self):
        config = _config(agent_id="cfg", agent_image_url="http://cfg", agent_image=object())
        assert select_lemonslice_source(config, "persona-agent") == {"agent_id": "persona-agent"}

    def test_config_fallbacks_without_a_ref(self):
        image = object()
        assert select_lemonslice_source(_config(agent_id="a"), "") == {"agent_id": "a"}
        assert select_lemonslice_source(_config(agent_image_url="http://u"), "") == {
            "agent_image_url": "http://u"
        }
        assert select_lemonslice_source(_config(agent_image=image), "") == {"agent_image": image}

    def test_no_source_at_all_is_none(self):
        assert select_lemonslice_source(_config(), "") is None

    def test_always_exactly_one_source(self):
        """The plugin raises on 0 or 2+ sources — selection must never produce them."""
        image = object()
        configs = [
            _config(),
            _config(agent_id="a"),
            _config(agent_image_url="http://u"),
            _config(agent_image=image),
            _config(agent_id="a", agent_image_url="http://u", agent_image=image),
        ]
        refs = ["", "agent-1", "https://x/p.jpg", f"{BLOB_REF_PREFIX}abc"]
        for config in configs:
            for ref in refs:
                got = select_lemonslice_source(config, ref)
                assert got is None or len(got) == 1, (config, ref, got)


# ---------------------------------------------------------------------------

DSN = os.environ.get("TUTOR_TEST_DATABASE_URL")


@pytest.mark.skipif(
    not DSN, reason="set TUTOR_TEST_DATABASE_URL to run the blob-loader integration tests"
)
class TestLoadBlobImage:
    @pytest.fixture
    def conn(self):
        psycopg = pytest.importorskip("psycopg", reason="requires the db extra")
        with psycopg.connect(DSN, autocommit=True) as connection:
            yield connection

    @pytest.fixture
    def blob_id(self, conn) -> str:
        import hashlib

        pytest.importorskip("PIL", reason="requires the lemonslice plugin's Pillow")
        data = _png_bytes()
        row = conn.execute(
            "INSERT INTO blobs (kind, content_type, bytes, byte_size, sha256) "
            "VALUES ('avatar_photo', 'image/png', %s, %s, %s) RETURNING id",
            (data, len(data), hashlib.sha256(data).hexdigest()),
        ).fetchone()
        blob_id = str(row[0])
        yield blob_id
        conn.execute("DELETE FROM blobs WHERE id = %s", (blob_id,))

    def test_round_trips_the_photo(self, blob_id):
        image = load_blob_image(f"{BLOB_REF_PREFIX}{blob_id}", dsn=DSN)
        assert image is not None
        assert image.size == (2, 2)

    def test_missing_blob_is_none(self):
        missing = "00000000-0000-0000-0000-000000000000"
        assert load_blob_image(f"{BLOB_REF_PREFIX}{missing}", dsn=DSN) is None

    def test_purged_blob_is_none(self, conn, blob_id):
        """§10: once the sweep clears a photo, sessions degrade to voice-only."""
        conn.execute("UPDATE blobs SET deleted_at = now() WHERE id = %s", (blob_id,))
        assert load_blob_image(f"{BLOB_REF_PREFIX}{blob_id}", dsn=DSN) is None

    def test_no_dsn_is_none(self):
        assert load_blob_image(f"{BLOB_REF_PREFIX}whatever", dsn=None) is None
