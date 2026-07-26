-- 0001_extensions — extensions the schema depends on.
--
-- pgvector is enabled now even though doc_chunks is deferred to Phase 4 (§12),
-- so the retrieval migration is a pure table add with no ops coordination.
-- citext backs users.email: case-insensitive uniqueness belongs in the type,
-- not in every INSERT site.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS citext;
