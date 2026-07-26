-- 0012_doc_chunks — the retrieval index (§7.1, Phase 4).
--
-- This is the sync plane's output and the only thing the tutor reads in-loop.
-- Two requirements from §13 shape the whole table:
--
--   1. "Enforce ACLs from doc_chunks.acl at retrieval time, never at ingestion
--      time only." A permission revoked upstream must take effect on the next
--      QUERY, not on the next resync — otherwise there is a window, as wide as
--      the sync interval, in which the tutor will happily quote a document the
--      learner just lost access to. So the ACL is a column that participates in
--      the WHERE clause, and it is indexed, because a filter that is too slow to
--      use in the hot path will eventually get skipped.
--
--   2. Per-chunk provenance so a purge is exact. Severing a linked account must
--      remove precisely that account's derived chunks, which is why provenance
--      is a foreign key rather than a string in `meta`.
--
-- Retrieval must stay ≤150ms in-loop (§4). That budget is why this is a local
-- index rather than per-question API calls, and why the vector index is HNSW.

-- The embedding width is voyage-3's native 1024, written inline rather than
-- behind a DOMAIN: pgvector wants the concrete type on the indexed expression.
-- Changing it is a reindex, not an ALTER — a mismatched vector fails on INSERT
-- rather than silently degrading. EMBEDDING_DIM in retrieval/embeddings.py
-- mirrors this number, and a test asserts the two agree.

-- Immutable extraction so acl.principals can back a generated column and a GIN
-- index. Filtering on jsonb directly would work and would also be the thing
-- that makes retrieval miss its budget once a user has real volume.
CREATE FUNCTION jsonb_principals(v jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT coalesce(
        (SELECT array_agg(p ORDER BY p)
         FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(v -> 'principals') = 'array'
                  THEN v -> 'principals'
                  ELSE '[]'::jsonb
             END
         ) AS p),
        '{}'::text[]
    );
$$;


CREATE TABLE doc_chunks (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Denormalized from the source deliberately. Every query filters on it, and
    -- joining two tables to find out who owns a row is not something to do
    -- inside a 150ms budget.
    user_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    -- Exactly one provenance root (§7.1 vs §7.5).
    linked_account_id uuid REFERENCES merge_linked_accounts (id) ON DELETE CASCADE,
    upload_id         uuid REFERENCES uploads (id) ON DELETE CASCADE,

    -- Merge's id for the source document; null for direct uploads.
    remote_id         text,

    -- Where a human would go to see this. Rendered by show_source (§5.2), so it
    -- is required: a chunk the tutor cannot attribute is a chunk it should not
    -- be teaching from.
    uri               text NOT NULL,
    title             text,

    chunk_ix          integer NOT NULL,
    text              text NOT NULL,
    embedding         vector(1024),

    -- How this chunk's visibility is decided. Explicit rather than inferred
    -- from an empty array: "no principals listed" must never accidentally mean
    -- "everyone".
    --   owner      — direct upload; the owning user, and nobody else.
    --   principals — synced content; requester must hold one of acl.principals.
    --
    -- acl_mode is text, not an enum, because casting text to an enum is STABLE
    -- rather than IMMUTABLE and Postgres refuses it in a generated column.
    -- doc_chunks_acl_mode_known below is the wall instead.
    acl               jsonb NOT NULL DEFAULT '{"mode": "owner"}'::jsonb,
    acl_mode          text GENERATED ALWAYS AS (acl ->> 'mode') STORED,
    acl_principals    text[] GENERATED ALWAYS AS (jsonb_principals(acl)) STORED,

    meta              jsonb NOT NULL DEFAULT '{}'::jsonb,

    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    -- Soft delete so a purge is observable and reversible within a support
    -- window. Queries filter it; the periodic hard delete is a separate job.
    deleted_at        timestamptz,

    CONSTRAINT doc_chunks_ix_nonneg CHECK (chunk_ix >= 0),
    CONSTRAINT doc_chunks_text_nonempty CHECK (length(btrim(text)) > 0),
    CONSTRAINT doc_chunks_meta_is_object CHECK (jsonb_typeof(meta) = 'object'),

    -- Exactly one root, never both, never neither. Without this a purge by
    -- linked account silently misses rows that claimed both parents.
    CONSTRAINT doc_chunks_one_source
        CHECK ((linked_account_id IS NULL) <> (upload_id IS NULL)),

    -- The ACL must be well-formed at write time, because a malformed one is
    -- unfilterable at read time. Note both halves are written to be false (not
    -- NULL) when the key is missing — a CHECK evaluating to NULL passes, and
    -- this is exactly the constraint where that would be dangerous.
    CONSTRAINT doc_chunks_acl_mode_known
        CHECK (jsonb_typeof(acl -> 'mode') IS NOT DISTINCT FROM 'string'
               AND (acl ->> 'mode') IN ('owner', 'principals')),
    CONSTRAINT doc_chunks_principals_present
        CHECK ((acl ->> 'mode') <> 'principals'
               OR jsonb_typeof(acl -> 'principals') IS NOT DISTINCT FROM 'array')
);

-- The purge paths from §7.1. Both are "delete everything derived from X", and
-- both need to be fast enough to run inside the webhook that reported the
-- change rather than in a nightly job.
CREATE INDEX doc_chunks_linked_account_idx
    ON doc_chunks (linked_account_id) WHERE linked_account_id IS NOT NULL;
CREATE INDEX doc_chunks_upload_idx
    ON doc_chunks (upload_id) WHERE upload_id IS NOT NULL;

-- Re-ingesting one document replaces its chunks in place instead of
-- accumulating duplicates that all match the same query.
CREATE UNIQUE INDEX doc_chunks_source_chunk_key
    ON doc_chunks (coalesce(linked_account_id, upload_id), coalesce(remote_id, uri), chunk_ix);

-- The ACL filter, as an overlap test rather than a jsonb containment scan.
CREATE INDEX doc_chunks_acl_principals_idx
    ON doc_chunks USING gin (acl_principals) WHERE deleted_at IS NULL;

-- Vector search. HNSW over IVFFlat: no training step (so it works from the
-- first row, which matters when every developer's local index is nearly empty)
-- and better recall at the low latency this has to hit. Cosine to match the
-- normalized embeddings the provider returns.
CREATE INDEX doc_chunks_embedding_idx
    ON doc_chunks USING hnsw (embedding vector_cosine_ops)
    WHERE deleted_at IS NULL;

-- Every search is scoped to one user first; this keeps that prefilter cheap.
CREATE INDEX doc_chunks_user_idx ON doc_chunks (user_id) WHERE deleted_at IS NULL;

CREATE TRIGGER doc_chunks_set_updated_at
    BEFORE UPDATE ON doc_chunks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE doc_chunks IS
    '§7.1 retrieval index. ACLs are enforced at query time (§13), not at ingestion.';
COMMENT ON COLUMN doc_chunks.acl IS
    '{"mode":"owner"} or {"mode":"principals","principals":[...]}. Mirrors Merge''s ACL model.';
COMMENT ON COLUMN doc_chunks.acl_principals IS
    'Generated from acl for GIN overlap. Filter with && at query time — never trust ingestion.';
COMMENT ON COLUMN doc_chunks.embedding IS
    'Nullable: a chunk is stored on ingest and embedded by the worker, so a failed embed is retryable.';
COMMENT ON COLUMN doc_chunks.deleted_at IS
    'Soft purge (§7.1). Set when a source is severed or a file disappears upstream.';
