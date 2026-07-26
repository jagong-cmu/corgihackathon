-- 0003_users — the account row.
--
-- README §10: the product is 18+, enforced at signup by self-attestation at
-- minimum. adult_attested_at records that attestation as a timestamp rather than
-- a boolean, because "when did they attest" is the question a compliance review
-- actually asks. It is nullable so a half-finished signup can persist, and
-- application code must refuse to open a session without it.

CREATE TABLE users (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email             citext NOT NULL,
    display_name      text,
    adult_attested_at timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    deleted_at        timestamptz,

    CONSTRAINT users_email_shaped CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

-- Soft-deleted accounts keep the row (session history, consent records) but must
-- not block a re-signup on the same address.
CREATE UNIQUE INDEX users_email_key ON users (email) WHERE deleted_at IS NULL;

CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN users.adult_attested_at IS
    '§10: 18+ self-attestation. NULL means signup is incomplete — do not open a session.';
COMMENT ON COLUMN users.deleted_at IS
    'Soft delete for the app. A §10 erasure request is a real DELETE, which cascades.';
