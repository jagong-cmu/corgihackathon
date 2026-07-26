"""Embeddings behind a Protocol, with a fake that ranks plausibly offline.

Voyage is the default because it is Anthropic's recommended embeddings partner
and there is no Anthropic embeddings endpoint to use instead. It sits behind
`EmbeddingProvider` for the same reason every other vendor here does.

`input_type` is not decoration. Voyage embeds a question and a passage into
different regions when told which is which, and retrieval quality drops
measurably if you embed both as the same type — so the protocol has two methods
rather than one, and the distinction is impossible to forget.
"""

from __future__ import annotations

import hashlib
import math
import re
from collections.abc import Sequence
from typing import Protocol, runtime_checkable

EMBEDDING_DIM = 1024
"""voyage-3's native width. Mirrors `vector(1024)` in migration 0012 — pgvector
fixes the dimension at index creation, so these two numbers changing apart means
every INSERT fails. `test_retrieval.py` asserts they agree."""


@runtime_checkable
class EmbeddingProvider(Protocol):
    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        """Embed passages for storage."""

    async def embed_query(self, text: str) -> list[float]:
        """Embed a question for search. Not interchangeable with the above."""


# ---------------------------------------------------------------------------
# offline
# ---------------------------------------------------------------------------

_WORD = re.compile(r"[a-z0-9']+")


class HashingEmbeddings:
    """Deterministic bag-of-words hashing, no network, no model.

    Real enough to test retrieval with. A random-per-call fake would let a
    broken ORDER BY pass, and a constant fake would let a broken similarity
    metric pass; this one actually ranks a matching passage above a
    non-matching one, so a test asserting "the syllabus chunk comes first" is
    testing something.

    What it is not: semantic. "car" and "automobile" are orthogonal here. Tests
    that depend on synonymy belong against the real provider.
    """

    def __init__(self, dim: int = EMBEDDING_DIM) -> None:
        self.dim = dim
        self.calls = 0

    def _vector(self, text: str) -> list[float]:
        vec = [0.0] * self.dim
        tokens = _WORD.findall(text.lower())
        for token in tokens:
            digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
            index = int.from_bytes(digest[:4], "big") % self.dim
            # Signed so unrelated tokens can cancel rather than only accumulate.
            sign = 1.0 if digest[4] & 1 else -1.0
            vec[index] += sign
        norm = math.sqrt(sum(v * v for v in vec))
        if norm == 0.0:
            # An empty or punctuation-only chunk. A zero vector has undefined
            # cosine distance, so park it on a fixed unit axis instead.
            vec[0] = 1.0
            return vec
        return [v / norm for v in vec]

    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        self.calls += 1
        return [self._vector(t) for t in texts]

    async def embed_query(self, text: str) -> list[float]:
        self.calls += 1
        return self._vector(text)


# ---------------------------------------------------------------------------
# voyage
# ---------------------------------------------------------------------------

_VOYAGE_URL = "https://api.voyageai.com/v1/embeddings"

MAX_BATCH = 128
"""Voyage's per-request document cap. Ingestion batches are unbounded in
principle (a 300-page PDF), so the provider chunks its own requests rather than
making every caller remember this."""


class VoyageEmbeddings:
    """Satisfies EmbeddingProvider. Requires the `embeddings` extra and a key."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str = "voyage-3",
        dim: int = EMBEDDING_DIM,
        timeout: float = 20.0,
    ) -> None:
        try:
            import httpx
        except ImportError as exc:  # pragma: no cover - depends on optional extra
            raise ImportError(
                "the embeddings extra is not installed. Run: uv sync --extra embeddings"
            ) from exc

        self.model = model
        self.dim = dim
        self._client = httpx.AsyncClient(
            timeout=timeout, headers={"Authorization": f"Bearer {api_key}"}
        )

    async def _embed(self, texts: Sequence[str], input_type: str) -> list[list[float]]:
        out: list[list[float]] = []
        for start in range(0, len(texts), MAX_BATCH):
            batch = list(texts[start : start + MAX_BATCH])
            response = await self._client.post(
                _VOYAGE_URL,
                json={"input": batch, "model": self.model, "input_type": input_type},
            )
            response.raise_for_status()
            payload = response.json()
            # The API documents that `data` comes back in request order, but an
            # off-by-one here would attach the wrong text to the wrong vector
            # and be invisible except as bad results. Sort explicitly.
            ordered = sorted(payload["data"], key=lambda row: row["index"])
            vectors = [row["embedding"] for row in ordered]
            if len(vectors) != len(batch):
                raise ValueError(
                    f"voyage returned {len(vectors)} embeddings for {len(batch)} inputs"
                )
            for vector in vectors:
                if len(vector) != self.dim:
                    raise ValueError(
                        f"voyage model {self.model!r} returned dim {len(vector)}, "
                        f"but doc_chunks.embedding is vector({self.dim}). "
                        "Changing embedding model means a reindex, not a config flip."
                    )
            out.extend(vectors)
        return out

    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        return await self._embed(texts, "document")

    async def embed_query(self, text: str) -> list[float]:
        (vector,) = await self._embed([text], "query")
        return vector

    async def aclose(self) -> None:
        await self._client.aclose()
