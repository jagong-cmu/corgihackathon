"""Sync-plane retrieval (§7.1): what the tutor knows, answered in ≤150ms.

The action plane (Merge Agent Handler, §7.2) is deliberately not here. It has
opposite properties — slow, governed, narration-covered, never awaited inside a
speech segment — and putting the two behind one interface is how the fast path
ends up waiting on the slow one.

`pgvector` and the real embedder are imported lazily so the package stays
installable and testable with no database and no keys.
"""

from __future__ import annotations

from .documents import DocumentChunk, chunk_document, normalize
from .embeddings import EMBEDDING_DIM, EmbeddingProvider, HashingEmbeddings

__all__ = [
    "EMBEDDING_DIM",
    "DocumentChunk",
    "EmbeddingProvider",
    "HashingEmbeddings",
    "chunk_document",
    "normalize",
]
