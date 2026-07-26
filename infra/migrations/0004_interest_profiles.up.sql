-- 0004_interest_profiles — what the learner is into, as vetted taxonomy keys.
--
-- Drives simulation theming and the fal.ai sprite-pack pipeline (§6.5). The
-- sketch in §11 keys this by user_id; one profile per user is the real cardinality,
-- so user_id IS the primary key instead of carrying a pointless surrogate id.
--
-- The taxonomy key check is a safety control, not tidiness: §6.5 forbids raw user
-- free text from reaching an image-generation prompt, and this is where that rule
-- stops being a convention.

CREATE TABLE interest_profiles (
    user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    interests  jsonb NOT NULL DEFAULT '[]'::jsonb,
    source     text NOT NULL DEFAULT 'onboarding',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT interest_profiles_interests_are_taxonomy_keys
        CHECK (taxonomy_key_array_ok(interests)),
    CONSTRAINT interest_profiles_source_nonempty
        CHECK (length(btrim(source)) > 0)
);

-- "which learners like basketball" — the asset-pack job's query.
CREATE INDEX interest_profiles_interests_gin ON interest_profiles USING gin (interests);

CREATE TRIGGER interest_profiles_set_updated_at
    BEFORE UPDATE ON interest_profiles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN interest_profiles.interests IS
    'Array of vetted taxonomy keys, e.g. ["basketball","cooking"]. Never raw user text (§6.5).';
COMMENT ON COLUMN interest_profiles.source IS
    'How these were captured: onboarding | inferred | edited.';
