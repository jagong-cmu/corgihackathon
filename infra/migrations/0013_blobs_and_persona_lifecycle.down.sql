-- Reverse of 0013. `make verify` fails if anything survives in public.

-- 3. Restore the original (stricter) consent constraint.
ALTER TABLE personas DROP CONSTRAINT personas_real_person_requires_consent;

ALTER TABLE personas ADD CONSTRAINT personas_real_person_requires_consent CHECK (
    kind <> 'real_person'
    OR (
        consent_status = 'granted'
        AND consent_captured_in_session
        AND consent_revoked_at IS NULL
    )
);

-- 2. Drop deleted_at and restore the original partial unique indexes.
DROP INDEX IF EXISTS personas_owner_slug_key;
DROP INDEX IF EXISTS personas_library_slug_key;

ALTER TABLE personas DROP COLUMN IF EXISTS deleted_at;

CREATE UNIQUE INDEX personas_owner_slug_key ON personas (owner_user_id, slug)
    WHERE owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX personas_library_slug_key ON personas (slug)
    WHERE owner_user_id IS NULL;

-- 1. blobs
DROP TABLE IF EXISTS blobs;
DROP TYPE IF EXISTS blob_kind;
