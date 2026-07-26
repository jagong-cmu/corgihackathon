"""pgvector retrieval and the ingestion path that fills it.

Search satisfies `RetrievalProvider` and is the only part that runs in the voice
loop, so it is the only part written with the ≤150ms budget in mind (§4):
one round trip, one index scan, no joins.

The ACL rule from §13 is implemented in `_SEARCH_SQL` and nowhere else. It is
written to fail closed at every step:

  - `user_id = $1` always applies. Ownership is necessary, never sufficient.
  - an `owner`-mode chunk needs nothing further; it is a direct upload.
  - a `principals`-mode chunk must overlap the requester's groups. An empty
    group set therefore matches nothing, rather than everything.
  - a chunk whose mode is neither cannot exist (the CHECK in migration 0012),
    but the SQL still enumerates the two modes rather than negating one, so a
    future third mode is invisible until someone handles it deliberately.

Requires the `postgres` extra.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from ..providers.base import Chunk, Principal
from .embeddings import EMBEDDING_DIM, EmbeddingProvider

log = logging.getLogger(__name__)


def to_pgvector(values: Sequence[float]) -> str:
    """pgvector's text input format.

    Sent as text rather than through a binary codec so this module needs only
    asyncpg, with no `pgvector` package and no per-connection type registration
    to forget on a fresh pool.
    """
    if len(values) != EMBEDDING_DIM:
        raise ValueError(
            f"expected a {EMBEDDING_DIM}-dim embedding, got {len(values)}. "
            "The column is vector(1024) and will reject this at INSERT."
        )
    return "[" + ",".join(repr(float(v)) for v in values) + "]"


# The §13 rule, written once. Every path that reads a chunk composes this
# predicate rather than restating it: search feeds the voice loop, fetch_chunk
# feeds `show_source`, and a client that can put a chunk on the board by id must
# not be able to reach one that search would have refused to return.
#
# $1 is the requester's user_id and the last placeholder is their group array;
# callers substitute the group parameter's number because it lands in a
# different position in each statement.
def _acl_predicate(groups_param: str) -> str:
    return f"""
    user_id = $1
      AND deleted_at IS NULL
      AND (
            acl_mode = 'owner'
         OR (acl_mode = 'principals' AND acl_principals && {groups_param}::text[])
      )
    """


# `<=>` is cosine distance in [0, 2]; score is the similarity the caller expects.
# The ORDER BY is on the raw distance so the HNSW index is usable — ordering by
# the derived score would defeat it.
_SEARCH_SQL = f"""
SELECT id::text          AS chunk_id,
       text,
       uri,
       title,
       1 - (embedding <=> $2::vector) AS score
FROM doc_chunks
WHERE {_acl_predicate("$3")}
  AND embedding IS NOT NULL
ORDER BY embedding <=> $2::vector
LIMIT $4
"""

# `show_source` names a chunk the model saw in its retrieved context, so it is
# already ACL-cleared for this principal — but the fetch re-checks anyway. The
# id travels out to the client and back, and a check that only runs on the way
# out is not a check.
_FETCH_SQL = f"""
SELECT id::text AS chunk_id, text, uri, title
FROM doc_chunks
WHERE {_acl_predicate("$3")}
  AND id = $2::uuid
"""

_UPSERT_SQL = """
INSERT INTO doc_chunks
    (user_id, linked_account_id, upload_id, remote_id, uri, title,
     chunk_ix, text, embedding, acl, meta)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10::jsonb, $11::jsonb)
ON CONFLICT (coalesce(linked_account_id, upload_id), coalesce(remote_id, uri), chunk_ix)
DO UPDATE SET
    text       = EXCLUDED.text,
    title      = EXCLUDED.title,
    embedding  = EXCLUDED.embedding,
    acl        = EXCLUDED.acl,
    meta       = EXCLUDED.meta,
    uri        = EXCLUDED.uri,
    -- Re-ingesting a document that was previously purged revives its chunks
    -- rather than leaving invisible duplicates behind the unique index.
    deleted_at = NULL
"""


@dataclass(frozen=True)
class SourceRef:
    """Which provenance root a chunk belongs to. Exactly one, per §7.1/§7.5."""

    user_id: str
    linked_account_id: str | None = None
    upload_id: str | None = None
    remote_id: str | None = None

    def __post_init__(self) -> None:
        if (self.linked_account_id is None) == (self.upload_id is None):
            raise ValueError(
                "a chunk needs exactly one of linked_account_id or upload_id "
                "(doc_chunks_one_source). Both or neither makes purge-by-source unsound."
            )


@dataclass(frozen=True)
class Acl:
    """A chunk's visibility, mirroring `doc_chunks.acl`."""

    mode: str = "owner"
    principals: frozenset[str] = frozenset()

    @staticmethod
    def owner() -> Acl:
        return Acl()

    @staticmethod
    def shared_with(principals: Sequence[str]) -> Acl:
        return Acl(mode="principals", principals=frozenset(principals))

    def to_json(self) -> dict[str, Any]:
        if self.mode == "owner":
            return {"mode": "owner"}
        return {"mode": "principals", "principals": sorted(self.principals)}


@dataclass
class PgVectorRetrieval:
    """Satisfies RetrievalProvider over Postgres + pgvector.

    Takes a pool rather than a DSN: the worker opens one pool for the process,
    and paying connection setup inside a 150ms in-loop budget is not viable.
    """

    pool: Any
    embeddings: EmbeddingProvider
    _search_sql: str = field(default=_SEARCH_SQL, repr=False)
    _fetch_sql: str = field(default=_FETCH_SQL, repr=False)

    async def search(self, query: str, *, principal: Principal, limit: int = 5) -> list[Chunk]:
        if not query.strip():
            return []
        vector = await self.embeddings.embed_query(query)
        rows = await self.pool.fetch(
            self._search_sql,
            principal.user_id,
            to_pgvector(vector),
            list(principal.groups),
            limit,
        )
        return [
            Chunk(
                chunk_id=row["chunk_id"],
                text=row["text"],
                uri=row["uri"],
                title=row["title"],
                score=float(row["score"]),
            )
            for row in rows
        ]

    async def fetch_chunk(self, chunk_id: str, *, principal: Principal) -> Chunk | None:
        """One chunk by id, or None if it doesn't exist or isn't theirs.

        Backs `show_source` (§5.2): the model names a chunk id from its
        retrieved context and the client fetches the text to put on the board.
        Returns None rather than raising for a miss — the board renders an
        "unavailable" card and the lesson continues.
        """
        try:
            rows = await self.pool.fetch(
                self._fetch_sql, principal.user_id, chunk_id, list(principal.groups)
            )
        except Exception:
            # A malformed id reaches Postgres as a failed uuid cast. That is a
            # 404, not a 500 — the id came from a model and can be anything.
            log.warning("chunk fetch failed for %r", chunk_id, exc_info=True)
            return None
        if not rows:
            return None
        row = rows[0]
        return Chunk(
            chunk_id=row["chunk_id"],
            text=row["text"],
            uri=row["uri"],
            title=row["title"],
            score=1.0,
        )

    # -- ingestion ----------------------------------------------------------
    #
    # Not in the voice loop. Runs from webhook consumers and the upload handler
    # (§7.1); latency here is irrelevant next to correctness of provenance.

    async def upsert_document(
        self,
        *,
        source: SourceRef,
        uri: str,
        text: str,
        title: str | None = None,
        acl: Acl | None = None,
        meta: dict[str, Any] | None = None,
        target_chars: int | None = None,
    ) -> int:
        """Chunk, embed, and store one document. Returns the chunk count.

        Replaces the document's previous chunks rather than adding to them: the
        unique index makes re-ingestion idempotent, and any chunks left over
        from a longer previous version are purged so a shortened document can't
        keep answering from text it no longer contains.
        """
        import json

        from .documents import chunk_document

        kwargs = {"target_chars": target_chars} if target_chars else {}
        chunks = chunk_document(text, **kwargs)
        if not chunks:
            log.info("nothing to index for %s — empty after normalization", uri)
            await self.purge_document(source=source, uri=uri)
            return 0

        vectors = await self.embeddings.embed_documents([c.text for c in chunks])
        if len(vectors) != len(chunks):
            raise ValueError(f"embedder returned {len(vectors)} vectors for {len(chunks)} chunks")

        acl_json = json.dumps((acl or Acl.owner()).to_json())
        meta_json = json.dumps(meta or {})

        async with self.pool.acquire() as conn:
            async with conn.transaction():
                for chunk, vector in zip(chunks, vectors, strict=True):
                    await conn.execute(
                        _UPSERT_SQL,
                        source.user_id,
                        source.linked_account_id,
                        source.upload_id,
                        source.remote_id,
                        uri,
                        title,
                        chunk.ix,
                        chunk.text,
                        to_pgvector(vector),
                        acl_json,
                        meta_json,
                    )
                # A rewrite that produced fewer chunks leaves a tail behind.
                await conn.execute(
                    """
                    UPDATE doc_chunks SET deleted_at = now()
                    WHERE coalesce(linked_account_id, upload_id) = coalesce($1::uuid, $2::uuid)
                      AND coalesce(remote_id, uri) = coalesce($3, $4)
                      AND chunk_ix >= $5
                      AND deleted_at IS NULL
                    """,
                    source.linked_account_id,
                    source.upload_id,
                    source.remote_id,
                    uri,
                    len(chunks),
                )
        return len(chunks)

    async def purge_document(self, *, source: SourceRef, uri: str) -> int:
        """Soft-delete every chunk of one document.

        Called when Merge reports a file removed (§7.1). Soft rather than hard so
        the purge is auditable and a mistaken webhook is recoverable; the hard
        delete is a separate retention job.
        """
        result = await self.pool.execute(
            """
            UPDATE doc_chunks SET deleted_at = now()
            WHERE coalesce(linked_account_id, upload_id) = coalesce($1::uuid, $2::uuid)
              AND coalesce(remote_id, uri) = coalesce($3, $4)
              AND deleted_at IS NULL
            """,
            source.linked_account_id,
            source.upload_id,
            source.remote_id,
            uri,
        )
        return _rowcount(result)

    async def purge_linked_account(self, linked_account_id: str) -> int:
        """Everything derived from one severed source (§7.1).

        "Disconnecting the source purges its chunks" is the Phase 4 done-when
        criterion, and it is this function.
        """
        result = await self.pool.execute(
            """
            UPDATE doc_chunks SET deleted_at = now()
            WHERE linked_account_id = $1::uuid AND deleted_at IS NULL
            """,
            linked_account_id,
        )
        purged = _rowcount(result)
        log.info("purged %d chunks from linked account %s", purged, linked_account_id)
        return purged

    async def purge_upload(self, upload_id: str) -> int:
        result = await self.pool.execute(
            """
            UPDATE doc_chunks SET deleted_at = now()
            WHERE upload_id = $1::uuid AND deleted_at IS NULL
            """,
            upload_id,
        )
        return _rowcount(result)


def _rowcount(status: str) -> int:
    """asyncpg returns a command tag like 'UPDATE 12'."""
    try:
        return int(str(status).rsplit(" ", 1)[-1])
    except (ValueError, IndexError):  # pragma: no cover - defensive
        return 0
