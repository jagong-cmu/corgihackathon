"""API tests against a real Postgres.

The point of this API is that consent rules enforce themselves on every write,
and half that enforcement lives in CHECK constraints. Mocking the database would
test the half that doesn't matter.

Skipped automatically when no database is reachable:

    cd infra && make up
"""

from __future__ import annotations

import uuid

import psycopg
import pytest
from fastapi.testclient import TestClient

from tutor_api.app import app, get_conn, resolve_dsn

DSN = resolve_dsn()


def _db_available() -> bool:
    try:
        with psycopg.connect(DSN, connect_timeout=2):
            return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _db_available(), reason=f"no database at {DSN} — run `cd infra && make up`"
)


@pytest.fixture
def conn():
    with psycopg.connect(DSN, autocommit=True) as connection:
        yield connection


@pytest.fixture
def owner(conn) -> str:
    """A throwaway user, cascade-deleted at the end along with its personas."""
    user_id = conn.execute(
        "INSERT INTO users (email, adult_attested_at) VALUES (%s, now()) RETURNING id",
        (f"api-test-{uuid.uuid4()}@example.test",),
    ).fetchone()[0]
    yield str(user_id)
    conn.execute("DELETE FROM users WHERE id = %s", (user_id,))


@pytest.fixture
def client(conn):
    app.dependency_overrides[get_conn] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def _spec(slug: str, **overrides) -> dict:
    base = {
        "id": slug,
        "kind": "self",
        "identity": {"name": "Test Tutor", "relationship": "the learner's study partner"},
        "speech": {"catchphrases": ["okay so"], "verbosity": "terse"},
        "pedagogy": {"style": "socratic", "on_wrong_answer": "asks what led them there"},
        "few_shot": [{"student": "I don't get it.", "tutor": "Mm. What part?"}],
        "never_does": ["says 'Great question!'"],
    }
    base.update(overrides)
    return base


class TestPersonaCrud:
    def test_create_and_read_back(self, client, owner):
        slug = f"t{uuid.uuid4().hex[:8]}"
        r = client.post("/personas", json=_spec(slug), headers={"X-User-Id": owner})
        assert r.status_code == 201, r.text

        got = client.get(f"/personas/{slug}", headers={"X-User-Id": owner})
        assert got.status_code == 200
        assert got.json()["identity"]["name"] == "Test Tutor"

    def test_full_persona_authoring_round_trips(self, client, owner):
        """The whole point of full authoring: mannerism survives the round trip,
        not just name and face."""
        slug = f"t{uuid.uuid4().hex[:8]}"
        client.post("/personas", json=_spec(slug), headers={"X-User-Id": owner})

        body = client.get(f"/personas/{slug}", headers={"X-User-Id": owner}).json()
        assert body["speech"]["catchphrases"] == ["okay so"]
        assert body["few_shot"][0]["tutor"] == "Mm. What part?"
        assert body["never_does"] == ["says 'Great question!'"]

    def test_patch_merges_and_revalidates(self, client, owner):
        slug = f"t{uuid.uuid4().hex[:8]}"
        client.post("/personas", json=_spec(slug), headers={"X-User-Id": owner})

        r = client.patch(
            f"/personas/{slug}",
            json={"never_does": ["lectures"]},
            headers={"X-User-Id": owner},
        )
        assert r.status_code == 200
        assert r.json()["never_does"] == ["lectures"]
        # Untouched fields survive the merge.
        assert r.json()["speech"]["catchphrases"] == ["okay so"]

    def test_missing_persona_is_404(self, client, owner):
        assert client.get("/personas/nope", headers={"X-User-Id": owner}).status_code == 404

    def test_owners_are_isolated(self, client, conn, owner):
        """One learner's tutors must not be visible to another."""
        slug = f"t{uuid.uuid4().hex[:8]}"
        client.post("/personas", json=_spec(slug), headers={"X-User-Id": owner})

        other = str(
            conn.execute(
                "INSERT INTO users (email) VALUES (%s) RETURNING id",
                (f"other-{uuid.uuid4()}@example.test",),
            ).fetchone()[0]
        )
        try:
            assert client.get(f"/personas/{slug}", headers={"X-User-Id": other}).status_code == 404
        finally:
            conn.execute("DELETE FROM users WHERE id = %s", (other,))


class TestConsentEnforcement:
    """§9/§10. The API must not be a way around the rules."""

    def test_real_person_without_consent_is_rejected(self, client, owner):
        slug = f"t{uuid.uuid4().hex[:8]}"
        r = client.post(
            "/personas", json=_spec(slug, kind="real_person"), headers={"X-User-Id": owner}
        )
        # Caught by the pydantic validator before it reaches the database.
        assert r.status_code == 422
        assert "consent" in r.text.lower()

    def test_real_person_with_uploaded_media_is_rejected(self, client, owner):
        slug = f"t{uuid.uuid4().hex[:8]}"
        r = client.post(
            "/personas",
            json=_spec(
                slug,
                kind="real_person",
                consent={"status": "granted", "captured_in_session": False},
            ),
            headers={"X-User-Id": owner},
        )
        assert r.status_code == 422
        assert "captured inside the consent session" in r.text

    def test_real_person_with_full_consent_is_accepted(self, client, owner):
        slug = f"t{uuid.uuid4().hex[:8]}"
        r = client.post(
            "/personas",
            json=_spec(
                slug,
                kind="real_person",
                consent={
                    "status": "granted",
                    "captured_in_session": True,
                    "granted_at": "2026-07-01T00:00:00Z",
                },
            ),
            headers={"X-User-Id": owner},
        )
        assert r.status_code == 201, r.text

    def test_revocation_hides_the_persona_but_keeps_the_row(self, client, conn, owner):
        """The bug fixed in 0011: a revoked persona must survive so the §10
        vendor-deletion sweep can find it."""
        slug = f"t{uuid.uuid4().hex[:8]}"
        client.post("/personas", json=_spec(slug), headers={"X-User-Id": owner})

        assert (
            client.post(f"/personas/{slug}/revoke", headers={"X-User-Id": owner}).status_code == 204
        )

        still_there = conn.execute(
            "SELECT is_revoked FROM personas WHERE slug = %s AND owner_user_id = %s",
            (slug, owner),
        ).fetchone()
        assert still_there is not None and still_there[0] is True

    def test_patch_cannot_smuggle_a_persona_past_consent(self, client, owner):
        """A patch is merged and re-validated whole, so you can't flip kind to
        real_person one field at a time."""
        slug = f"t{uuid.uuid4().hex[:8]}"
        client.post("/personas", json=_spec(slug), headers={"X-User-Id": owner})

        r = client.patch(
            f"/personas/{slug}", json={"kind": "real_person"}, headers={"X-User-Id": owner}
        )
        assert r.status_code == 422


class TestAvatarUpload:
    PNG = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
        "890000000a49444154789c6360000002000100ffff03000006000557bfabd400"
        "00000049454e44ae426082"
    )

    def test_upload_sets_a_blob_backed_avatar_ref(self, client, owner):
        slug = f"t{uuid.uuid4().hex[:8]}"
        client.post("/personas", json=_spec(slug), headers={"X-User-Id": owner})

        r = client.post(
            f"/personas/{slug}/avatar",
            files={"file": ("face.png", self.PNG, "image/png")},
            headers={"X-User-Id": owner},
        )
        assert r.status_code == 200, r.text
        assert r.json()["avatar_ref"].startswith("blob:")

        persona = client.get(f"/personas/{slug}", headers={"X-User-Id": owner}).json()
        assert persona["avatar"]["avatar_ref"] == r.json()["avatar_ref"]

    def test_uploaded_bytes_come_back_intact(self, client, owner):
        slug = f"t{uuid.uuid4().hex[:8]}"
        client.post("/personas", json=_spec(slug), headers={"X-User-Id": owner})
        blob_id = client.post(
            f"/personas/{slug}/avatar",
            files={"file": ("face.png", self.PNG, "image/png")},
            headers={"X-User-Id": owner},
        ).json()["blob_id"]

        assert client.get(f"/blobs/{blob_id}").content == self.PNG

    def test_non_image_is_rejected(self, client, owner):
        slug = f"t{uuid.uuid4().hex[:8]}"
        client.post("/personas", json=_spec(slug), headers={"X-User-Id": owner})
        r = client.post(
            f"/personas/{slug}/avatar",
            files={"file": ("x.exe", b"MZ\x00\x00", "application/octet-stream")},
            headers={"X-User-Id": owner},
        )
        assert r.status_code == 415

    def test_upload_to_a_missing_persona_is_404(self, client, owner):
        r = client.post(
            "/personas/nope/avatar",
            files={"file": ("face.png", self.PNG, "image/png")},
            headers={"X-User-Id": owner},
        )
        assert r.status_code == 404


class TestVoiceAssignment:
    def test_library_voice_can_be_assigned_without_cloning(self, client, owner):
        slug = f"t{uuid.uuid4().hex[:8]}"
        client.post("/personas", json=_spec(slug), headers={"X-User-Id": owner})

        r = client.post(
            f"/personas/{slug}/voice?voice_id=Xb7hH8MSUJpSbSDYk0k2",
            headers={"X-User-Id": owner},
        )
        assert r.status_code == 200, r.text
        assert r.json() == {"voice_id": "Xb7hH8MSUJpSbSDYk0k2", "cloned": False}

    def test_voice_id_and_upload_are_mutually_exclusive(self, client, owner):
        slug = f"t{uuid.uuid4().hex[:8]}"
        client.post("/personas", json=_spec(slug), headers={"X-User-Id": owner})
        assert (
            client.post(f"/personas/{slug}/voice", headers={"X-User-Id": owner}).status_code == 400
        )


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}
