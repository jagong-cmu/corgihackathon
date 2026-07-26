"""The persona/voice/avatar API (apps/api) as a Vercel Python function.

The browser calls same-origin `/tutor-api/*` (dev: the vite proxy; here: the
vercel.json rewrite pointing at this function). Vercel hands the ASGI app the
ORIGINAL request path, so a thin wrapper strips the `/tutor-api` prefix and
delegates to the FastAPI app unchanged — the deployed API and the local one
are literally the same code.

Deliberately DOWN until a database is attached: without DATABASE_URL (or the
POSTGRES_* set a marketplace integration writes), every request answers 503.
The frontend treats a non-ok `/tutor-api/health` as "builder unavailable" and
keeps its graceful local-only fallback — half-configured must not look alive.
"""

from __future__ import annotations

import json
import os

from tutor_api.app import app as _tutor_app

_PREFIXES = ("/tutor-api", "/api/tutor-api")


def _database_configured() -> bool:
    return bool(
        os.environ.get("DATABASE_URL")
        or os.environ.get("POSTGRES_URL")
        or os.environ.get("POSTGRES_HOST")
    )


async def _respond_json(send, status: int, payload: dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"application/json")],
        }
    )
    await send({"type": "http.response.body", "body": body})


class _TutorApiEntry:
    """Strip the public prefix, gate on database presence, delegate."""

    def __init__(self, inner) -> None:
        self._inner = inner

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self._inner(scope, receive, send)
            return

        if not _database_configured():
            await _respond_json(
                send,
                503,
                {
                    "detail": "tutor API has no database on this deployment — "
                    "attach a Postgres (Vercel → Storage) and redeploy"
                },
            )
            return

        path = scope.get("path", "")
        for prefix in _PREFIXES:
            if path == prefix or path.startswith(prefix + "/"):
                scope = dict(scope)
                scope["path"] = path[len(prefix) :] or "/"
                break
        await self._inner(scope, receive, send)


app = _TutorApiEntry(_tutor_app)
