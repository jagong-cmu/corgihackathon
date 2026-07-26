"""Starting a lesson: one call that hands the browser everything it needs.

`POST /session` resolves who the learner is, mints a LiveKit join token, and
returns the room to connect to. The agent worker meets them there.

## Why the identity travels in the token's metadata

The worker enforces retrieval ACLs per learner (§13), so it has to know *which*
learner is in the room, and it has to learn that from something the browser
cannot forge. Participant metadata is set on the server side when the token is
signed and is delivered to the room by LiveKit, so a client that edits its own
copy simply fails to connect. Passing the user id as a query parameter or a data
message instead would make "read another learner's materials" a one-line change
in devtools.

## Auth is still a stub

`X-User-Id` names an existing learner and an absent one bootstraps a row from
`email`. That is a development affordance, not authentication — anyone can claim
any id. Real auth is a §10 prerequisite for anything but a demo, and the 18+
attestation gate (`users.adult_attested_at`) is not enforced here either.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import timedelta
from typing import Annotated, Any

import psycopg
from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)

router = APIRouter(tags=["session"])

# Long enough for a tutoring session, short enough that a leaked token isn't
# a standing invitation. LiveKit only checks the TTL at join time, so a session
# already in progress is never cut off by it.
TOKEN_TTL = timedelta(hours=2)

DEFAULT_PERSONA = os.environ.get("TUTOR_PERSONA", "ada")

# The stub identity. Has to survive `users_email_shaped`, which requires a dot
# after the @ — 'dev@localhost' does not.
DEV_EMAIL = os.environ.get("TUTOR_DEV_EMAIL", "learner@localhost.dev")


class SessionRequest(BaseModel):
    email: str | None = Field(
        default=None,
        description="Bootstraps a learner row when there is no X-User-Id. Auth stub.",
    )
    display_name: str | None = None
    persona: str | None = Field(
        default=None, description="Persona slug the worker should run. Defaults to TUTOR_PERSONA."
    )


class SessionResponse(BaseModel):
    user_id: str
    persisted: bool
    """False when there is no database. The session still runs; retrieval is off
    and nothing about it is recorded."""

    room: str
    identity: str
    url: str
    token: str
    persona: str
    retrieval: dict[str, Any]


def _livekit_credentials() -> tuple[str, str, str]:
    url = os.environ.get("LIVEKIT_URL")
    key = os.environ.get("LIVEKIT_API_KEY")
    secret = os.environ.get("LIVEKIT_API_SECRET")
    if not (url and key and secret):
        missing = [
            name
            for name, value in (
                ("LIVEKIT_URL", url),
                ("LIVEKIT_API_KEY", key),
                ("LIVEKIT_API_SECRET", secret),
            )
            if not value
        ]
        raise HTTPException(
            503,
            f"LiveKit is not configured: {', '.join(missing)} unset. "
            "Source .env.local, or point at a livekit-server --dev instance.",
        )
    return url, key, secret


_ENSURE_USER_SQL = """
INSERT INTO users (email, display_name)
VALUES (%s, %s)
ON CONFLICT (email) WHERE deleted_at IS NULL
DO UPDATE SET display_name = coalesce(EXCLUDED.display_name, users.display_name)
RETURNING id
"""


def _resolve_user(x_user_id: str | None, body: SessionRequest) -> tuple[str, bool]:
    """(user_id, persisted).

    A database that is down degrades to an ephemeral id rather than a failed
    session: the learner still gets a tutor, just one with no memory of their
    uploads. The alternative — refusing to start — turns a retrieval outage into
    a total outage.
    """
    from .app import resolve_dsn

    if x_user_id:
        try:
            uuid.UUID(x_user_id)
        except ValueError as exc:
            raise HTTPException(400, f"X-User-Id must be a uuid, got {x_user_id!r}") from exc

    try:
        with psycopg.connect(resolve_dsn(), autocommit=True, connect_timeout=3) as conn:
            if x_user_id:
                row = conn.execute(
                    "SELECT id FROM users WHERE id = %s AND deleted_at IS NULL", (x_user_id,)
                ).fetchone()
                if row is None:
                    raise HTTPException(404, f"no learner {x_user_id}")
                return str(row[0]), True

            row = conn.execute(
                _ENSURE_USER_SQL, (body.email or DEV_EMAIL, body.display_name)
            ).fetchone()
            return str(row[0]), True
    except HTTPException:
        raise
    except psycopg.Error as exc:
        if x_user_id:
            # They named a specific learner; silently inventing a different one
            # would look like their materials had vanished.
            raise HTTPException(
                503, f"cannot verify X-User-Id without a database: {exc}"
            ) from exc
        log.warning("no database — running an ephemeral session with no retrieval (%s)", exc)
        return str(uuid.uuid4()), False


@router.post("/session", response_model=SessionResponse)
def start_session(
    request: Request,
    body: SessionRequest | None = None,
    x_user_id: Annotated[str | None, Header()] = None,
) -> SessionResponse:
    """Mint a join token for a lesson."""
    body = body or SessionRequest()
    url, key, secret = _livekit_credentials()

    try:
        from livekit import api
    except ImportError as exc:  # pragma: no cover - packaging failure, not a runtime path
        raise HTTPException(
            503, "livekit-api is not installed; cannot mint a join token"
        ) from exc

    user_id, persisted = _resolve_user(x_user_id, body)
    persona = body.persona or DEFAULT_PERSONA

    # One room per learner, so a reconnect after a dropped tab lands back in the
    # session that is already running rather than starting a second one.
    room = f"tutor-{user_id}"
    identity = f"learner-{user_id[:8]}"

    token = (
        api.AccessToken(key, secret)
        .with_identity(identity)
        .with_name(body.display_name or "Learner")
        # What the worker reads to scope retrieval. Signed server-side.
        .with_metadata(json.dumps({"user_id": user_id, "persona": persona}))
        .with_ttl(TOKEN_TTL)
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room,
                # The learner publishes a mic and nothing else. Video is
                # subscribe-only: the avatar publishes, the browser does not.
                can_publish=True,
                can_subscribe=True,
                can_publish_data=True,
            )
        )
        .to_jwt()
    )

    plane = getattr(request.app.state, "retrieval", None)
    return SessionResponse(
        user_id=user_id,
        persisted=persisted,
        room=room,
        identity=identity,
        url=url,
        token=token,
        persona=persona,
        retrieval=plane.status if plane is not None else {"available": False},
    )
