"""Starting a lesson.

The security-relevant assertion in here is small and easy to lose: the learner's
id is inside the *signed* token, not alongside it. Everything else about this
endpoint is plumbing; that one property is what stops a learner from reading
another learner's materials by editing a request.
"""

from __future__ import annotations

import json
import uuid

import jwt
import pytest
from fastapi.testclient import TestClient

from tutor_api.app import app

FAKE_LIVEKIT = {
    "LIVEKIT_URL": "ws://127.0.0.1:7880",
    "LIVEKIT_API_KEY": "devkey",
    "LIVEKIT_API_SECRET": "secret-that-is-long-enough-for-hs256",
}


@pytest.fixture
def livekit_env(monkeypatch):
    for key, value in FAKE_LIVEKIT.items():
        monkeypatch.setenv(key, value)
    return FAKE_LIVEKIT


@pytest.fixture(autouse=True)
def no_leaked_retrieval_plane():
    """`app` is module-level, so a plane opened by another test file outlives it.

    Without this, running the whole suite leaves a stale (and closed) retrieval
    plane on app.state, and the "no database" tests below assert against it and
    fail — in a way that passes when the file is run on its own. Isolation here
    rather than a shared conftest because this is the only file that asserts on
    retrieval being *absent*.
    """
    previous = getattr(app.state, "retrieval", None)
    app.state.retrieval = None
    yield
    app.state.retrieval = previous


@pytest.fixture
def client():
    return TestClient(app)


def _claims(token: str) -> dict:
    return jwt.decode(token, FAKE_LIVEKIT["LIVEKIT_API_SECRET"], algorithms=["HS256"])


class TestCredentials:
    def test_missing_livekit_config_names_what_is_unset(self, client, monkeypatch):
        for key in FAKE_LIVEKIT:
            monkeypatch.delenv(key, raising=False)
        response = client.post("/session")
        assert response.status_code == 503
        # The fix is an env var; say which one.
        assert "LIVEKIT_URL" in response.json()["detail"]


class TestToken:
    def test_identity_is_carried_in_signed_metadata(self, client, livekit_env):
        response = client.post("/session")
        assert response.status_code == 200
        body = response.json()

        claims = _claims(body["token"])
        metadata = json.loads(claims["metadata"])
        # This is the assertion that matters: the worker scopes retrieval to
        # this id, and it arrives signed. A client that edits it fails to join.
        assert metadata["user_id"] == body["user_id"]
        assert metadata["persona"] == body["persona"]

    def test_grants_are_scoped_to_one_room(self, client, livekit_env):
        body = client.post("/session").json()
        grants = _claims(body["token"])["video"]

        assert grants["room"] == body["room"]
        assert grants["roomJoin"] is True
        # The learner publishes a mic and receives audio, video, and canvas
        # frames. Nothing here should let them into a different lesson.
        assert grants.get("canPublish") is True
        assert grants.get("canSubscribe") is True
        assert grants.get("canPublishData") is True

    def test_room_is_stable_per_learner_so_a_reload_reconnects(self, client, livekit_env):
        first = client.post("/session", json={"email": "same@example.test"}).json()
        second = client.post("/session", json={"email": "same@example.test"}).json()
        # Without this a dropped tab starts a second lesson beside the first,
        # and the agent is talking into the room the learner just left.
        assert first["room"] == second["room"]

    def test_persona_can_be_chosen_per_session(self, client, livekit_env):
        body = client.post("/session", json={"persona": "coach-rios"}).json()
        assert body["persona"] == "coach-rios"
        assert json.loads(_claims(body["token"])["metadata"])["persona"] == "coach-rios"

    def test_malformed_user_id_is_rejected_before_anything_else(self, client, livekit_env):
        response = client.post("/session", headers={"X-User-Id": "not-a-uuid"})
        assert response.status_code == 400


class TestWithoutDatabase:
    """No Postgres is a supported configuration: voice works, retrieval doesn't."""

    def test_an_anonymous_session_still_starts(self, client, livekit_env, monkeypatch):
        monkeypatch.setenv("POSTGRES_HOST", "127.0.0.1")
        monkeypatch.setenv("POSTGRES_PORT", "1")  # nothing listens here
        monkeypatch.delenv("DATABASE_URL", raising=False)

        response = client.post("/session")
        assert response.status_code == 200
        body = response.json()
        # An ephemeral learner: a real session with no memory and no materials.
        assert body["persisted"] is False
        uuid.UUID(body["user_id"])
        assert body["retrieval"]["available"] is False

    def test_a_named_learner_is_not_silently_replaced(self, client, livekit_env, monkeypatch):
        monkeypatch.setenv("POSTGRES_HOST", "127.0.0.1")
        monkeypatch.setenv("POSTGRES_PORT", "1")
        monkeypatch.delenv("DATABASE_URL", raising=False)

        response = client.post("/session", headers={"X-User-Id": str(uuid.uuid4())})
        # Inventing a different id here would present as "all my uploads are
        # gone" rather than as an outage.
        assert response.status_code == 503
