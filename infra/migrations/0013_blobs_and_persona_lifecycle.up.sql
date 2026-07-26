-- Blob storage for uploaded media, plus the persona lifecycle columns that
-- runtime CRUD needs.
--
-- Three changes, one theme: making personas creatable and revocable through
-- the API rather than by editing YAML and restarting.

-- ---------------------------------------------------------------------------
-- 1. blobs
-- ---------------------------------------------------------------------------
-- Photos and voice samples live here rather than in object storage. LemonSlice
-- accepts image bytes as a multipart upload (agent_image), and ElevenLabs takes
-- audio the same way, so nothing needs a publicly fetchable URL. That removes
-- the whole S3/CDN/dev-tunnel tier for now; swap behind BlobStore when it earns
-- its keep.

CREATE TYPE blob_kind AS ENUM ('avatar_photo', 'voice_sample', 'consent_recording');

CREATE TABLE blobs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id uuid REFERENCES users (id) ON DELETE CASCADE,
    kind          blob_kind   NOT NULL,
    content_type  text        NOT NULL,
    bytes         bytea       NOT NULL,
    byte_size     integer     NOT NULL,
    sha256        text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    -- §10: delete raw voice/photo uploads after provider enrollment where
    -- feasible. This column is the mechanism for that sweep, not decoration.
    deleted_at    timestamptz,

    CONSTRAINT blobs_content_type_nonempty CHECK (length(btrim(content_type)) > 0),
    CONSTRAINT blobs_size_positive         CHECK (byte_size > 0),
    CONSTRAINT blobs_size_matches          CHECK (byte_size = octet_length(bytes)),
    CONSTRAINT blobs_sha256_shaped         CHECK (sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX blobs_owner_idx ON blobs (owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX blobs_kind_idx  ON blobs (kind)          WHERE deleted_at IS NULL;
-- The §10 retention sweep: which raw uploads are still undeleted, oldest first.
CREATE INDEX blobs_retention_idx ON blobs (created_at) WHERE deleted_at IS NULL;

CREATE TRIGGER blobs_set_updated_at
    BEFORE UPDATE ON blobs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE blobs IS
    'Uploaded media (avatar photos, voice samples, consent recordings). Bytes '
    'live here because LemonSlice and ElevenLabs both accept multipart uploads, '
    'so no public URL is needed. deleted_at drives the §10 retention sweep.';
COMMENT ON COLUMN blobs.sha256 IS
    'Content hash, for dedupe and for proving a consent recording is unmodified.';

-- ---------------------------------------------------------------------------
-- 2. personas.deleted_at
-- ---------------------------------------------------------------------------
-- sessions.persona_id is ON DELETE NO ACTION, so a hard DELETE fails for any
-- persona that has ever been used. Soft delete, following the users.deleted_at
-- pattern — including reworking the partial unique indexes so a deleted slug
-- can be reused.

ALTER TABLE personas ADD COLUMN deleted_at timestamptz;

DROP INDEX personas_owner_slug_key;
DROP INDEX personas_library_slug_key;

CREATE UNIQUE INDEX personas_owner_slug_key ON personas (owner_user_id, slug)
    WHERE owner_user_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX personas_library_slug_key ON personas (slug)
    WHERE owner_user_id IS NULL AND deleted_at IS NULL;

COMMENT ON COLUMN personas.deleted_at IS
    'Soft delete. Hard DELETE is impossible once a session references the '
    'persona (sessions.persona_id ON DELETE NO ACTION).';

-- ---------------------------------------------------------------------------
-- 3. Let a revoked real-person persona exist
-- ---------------------------------------------------------------------------
-- The original constraint required consent_revoked_at IS NULL for
-- kind = 'real_person'. That made the revoked state unrepresentable for exactly
-- the personas revocation exists for: §9 makes a persona revocable by the
-- person cloned at any time, and §10 requires a sweep that FINDS revoked
-- personas to delete their voice and avatar vendor-side. A row that cannot
-- exist cannot be swept.
--
-- The guarantee that matters is unchanged: you may not create a real-person
-- persona without granted, in-session-captured consent. Revocation is a
-- subsequent state, and refusing to serve a revoked persona belongs in the
-- application (persona.loader.get_persona), not in a CHECK.
--
-- Mirrors the same change in PersonaSpec._enforce_consent_rules.

ALTER TABLE personas DROP CONSTRAINT personas_real_person_requires_consent;

ALTER TABLE personas ADD CONSTRAINT personas_real_person_requires_consent CHECK (
    kind <> 'real_person'
    OR (
        consent_status IN ('granted', 'revoked')
        AND consent_captured_in_session
    )
);

COMMENT ON CONSTRAINT personas_real_person_requires_consent ON personas IS
    'A real-person persona must have had consent granted with media captured '
    'in-session. Revoked rows are permitted so the §10 vendor-deletion sweep '
    'can find them; get_persona() refuses to serve them.';
