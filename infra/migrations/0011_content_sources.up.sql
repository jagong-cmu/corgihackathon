-- 0011_content_sources — where a chunk came from.
--
-- doc_chunks (0012) needs a provenance root before it can exist, and §7.1 gives
-- it two: content synced through Merge, and content the learner uploaded
-- directly. Both land in the same index and take the same code path (§7.5), so
-- they are two tables and one nullable-pair FK rather than two pipelines.
--
-- Merge is the ONLY third-party gateway (§13) — that is why this table stores a
-- token *reference* and a category rather than provider-specific credentials.
-- There is nowhere in this schema to put a Google OAuth token, deliberately.

-- README §7.1/§7.2. Mirrors the Merge product categories we actually use;
-- growth categories (HRIS, §7.4) get an ALTER TYPE in a later migration.
CREATE TYPE merge_category AS ENUM ('filestorage', 'knowledgebase', 'ticketing');

-- Lifecycle of one authorized source. 'severed' is terminal and is what
-- triggers the purge in §7.1: disconnecting a source removes its chunks.
CREATE TYPE linked_account_status AS ENUM ('pending', 'active', 'paused', 'severed');


CREATE TABLE merge_linked_accounts (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    -- A reference to the account token in the secret store, never the token.
    -- Naming it _ref is load-bearing: it should be obviously wrong to write a
    -- credential into this column.
    merge_account_token_ref text NOT NULL,

    category                merge_category NOT NULL,

    -- Merge's own identifiers. remote_id is what webhooks arrive keyed by.
    provider                text NOT NULL,
    remote_id               text,

    -- What the learner picked in Merge Link (§7.1): the folders, drives, or
    -- spaces the tutor may read. This IS the data-minimization boundary, so an
    -- empty scope must mean "nothing", never "everything" — enforced by the
    -- ingestion worker, recorded here.
    scope                   jsonb NOT NULL DEFAULT '{}'::jsonb,

    status                  linked_account_status NOT NULL DEFAULT 'pending',
    linked_at               timestamptz,
    last_synced_at          timestamptz,
    severed_at              timestamptz,

    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT merge_linked_accounts_scope_is_object
        CHECK (jsonb_typeof(scope) = 'object'),

    -- A severed account without a timestamp makes the purge audit unanswerable.
    CONSTRAINT merge_linked_accounts_severed_has_time
        CHECK ((status = 'severed') = (severed_at IS NOT NULL)),

    CONSTRAINT merge_linked_accounts_active_is_linked
        CHECK (status <> 'active' OR linked_at IS NOT NULL)
);

CREATE INDEX merge_linked_accounts_user_idx
    ON merge_linked_accounts (user_id, category);

-- Webhook delivery looks the account up by Merge's id on every delta.
CREATE UNIQUE INDEX merge_linked_accounts_remote_key
    ON merge_linked_accounts (remote_id) WHERE remote_id IS NOT NULL;

-- The ingestion worker's work queue: who is due for a resync. §7.5 requires
-- respecting Merge's per-plan sync frequency rather than hammering resync.
CREATE INDEX merge_linked_accounts_sync_due_idx
    ON merge_linked_accounts (last_synced_at NULLS FIRST) WHERE status = 'active';

CREATE TRIGGER merge_linked_accounts_set_updated_at
    BEFORE UPDATE ON merge_linked_accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- Direct uploads: a photo of a problem set, a PDF the learner dragged in. Same
-- ingestion path, same index, no Merge involvement (§7.5).
CREATE TABLE uploads (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    filename     text NOT NULL,
    content_type text,
    byte_size    bigint,

    -- S3-compatible object key. Blobs never live in Postgres.
    blob_uri     text NOT NULL,

    created_at   timestamptz NOT NULL DEFAULT now(),
    deleted_at   timestamptz,

    CONSTRAINT uploads_byte_size_sane CHECK (byte_size IS NULL OR byte_size >= 0)
);

CREATE INDEX uploads_user_idx ON uploads (user_id, created_at DESC)
    WHERE deleted_at IS NULL;

COMMENT ON TABLE merge_linked_accounts IS
    '§7.1 sync plane: one source the learner authorized through Merge Link.';
COMMENT ON COLUMN merge_linked_accounts.merge_account_token_ref IS
    'Secret-store reference. Never the token itself.';
COMMENT ON COLUMN merge_linked_accounts.scope IS
    'The folders/spaces picked in Merge Link. The data-minimization boundary (§7.1).';
COMMENT ON COLUMN merge_linked_accounts.status IS
    'severed is terminal and triggers the doc_chunks purge (§7.1).';
COMMENT ON TABLE uploads IS
    'Direct learner uploads. Same ingestion path as Merge content (§7.5).';
