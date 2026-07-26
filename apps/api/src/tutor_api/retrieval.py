"""The retrieval index, as the API process sees it.

This is the *ingestion* half of the sync plane (§7.1). The worker owns the query
half. Both talk to the same `doc_chunks` table through the same
`PgVectorRetrieval` class, which is the point: there is one retrieval stack in
this repo and this module is not a second one.

Two things are worth knowing before changing anything here.

**The embedder must match the worker's.** Chunks are embedded on this side and
queried on that side. If the API indexes with `HashingEmbeddings` and the worker
queries with Voyage, every search runs against vectors from a different space —
no error, no empty result, just consistently irrelevant retrieval. Both
processes read `VOYAGE_API_KEY` and pick the same way, and `/health` reports
which one this process chose so the two can be compared without guessing.

**No database is a supported state.** The product is a voice tutor that can
teach from the learner's materials; without a database it is a voice tutor that
cannot, which is a smaller product rather than a broken one. The pool is opened
if `DATABASE_URL` is set and the endpoints that need it return 503 otherwise.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

log = logging.getLogger(__name__)


@dataclass
class RetrievalPlane:
    """Whatever ingestion capability this process actually has.

    Constructed once at startup. `store` is None when there is no database, and
    every caller is expected to check rather than to catch.
    """

    pool: Any | None = None
    store: Any | None = None
    embeddings_provider: str = "none"
    error: str | None = None

    @property
    def available(self) -> bool:
        return self.store is not None

    @property
    def status(self) -> dict[str, Any]:
        return {
            "available": self.available,
            "embeddings": self.embeddings_provider,
            "detail": self.error
            or (
                "indexing to doc_chunks"
                if self.available
                else "set DATABASE_URL to teach from uploaded materials"
            ),
        }


def resolve_dsn() -> str | None:
    """Only an explicit DATABASE_URL turns retrieval on.

    Deliberately stricter than `app.resolve_dsn()`, which assembles a default
    localhost DSN from POSTGRES_* so persona CRUD works out of the box. Doing
    that here would mean a machine with no Postgres spends every startup waiting
    on a connection to a database nobody asked for.
    """
    return os.environ.get("DATABASE_URL") or None


async def open_plane() -> RetrievalPlane:
    """Open the ingestion plane, or explain why it is off."""
    dsn = resolve_dsn()
    if not dsn:
        return RetrievalPlane()

    try:
        import asyncpg
        from tutor_agent.retrieval.embeddings import HashingEmbeddings, VoyageEmbeddings
        from tutor_agent.retrieval.pgvector import PgVectorRetrieval
    except ImportError as exc:
        detail = (
            f"retrieval extras not installed ({exc}). "
            "uv sync --extra postgres --extra embeddings"
        )
        log.warning(detail)
        return RetrievalPlane(error=detail)

    voyage_key = os.environ.get("VOYAGE_API_KEY")
    if voyage_key:
        embeddings: Any = VoyageEmbeddings(api_key=voyage_key)
        provider = "voyage"
    else:
        # Lexical, not semantic. Usable for a local demo and honest about it:
        # a learner uploading a syllabus and asking a paraphrased question will
        # get worse answers than they should.
        embeddings = HashingEmbeddings()
        provider = "hashing"
        log.warning(
            "VOYAGE_API_KEY unset — indexing with hashing embeddings. Retrieval will be "
            "keyword-ish, not semantic. The worker must run with the same setting."
        )

    try:
        pool = await asyncpg.create_pool(dsn, min_size=1, max_size=4)
    except Exception as exc:
        detail = f"could not connect to Postgres: {exc}"
        log.warning(detail)
        return RetrievalPlane(embeddings_provider=provider, error=detail)

    log.info("retrieval index open (%s embeddings)", provider)
    return RetrievalPlane(
        pool=pool,
        store=PgVectorRetrieval(pool=pool, embeddings=embeddings),
        embeddings_provider=provider,
    )


async def close_plane(plane: RetrievalPlane) -> None:
    if plane.pool is not None:
        await plane.pool.close()
