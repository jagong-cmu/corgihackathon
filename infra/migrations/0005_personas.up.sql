-- 0005_personas — a lossless home for PersonaSpec.
--
-- Authority: apps/agent/src/tutor_agent/persona/spec.py. Every field of
-- PersonaSpec (identity, speech, pedagogy, few_shot, never_does, voice, avatar,
-- consent) round-trips through this table; infra/scripts/seed.py proves it by
-- re-validating what it reads back.
--
-- Nested objects are flattened into columns rather than stored as one jsonb blob
-- for the two fields that are read outside the prompt builder — voice_id and
-- avatar_ref are looked up per session and per vendor-deletion sweep — and for
-- everything the DB can then actually constrain. few_shot stays jsonb because it
-- is an ordered list of small records that is only ever read whole.
--
-- CONSENT (§9/§10, PersonaSpec._enforce_consent_rules): the Python model already
-- refuses to construct a real-person persona without granted, in-session,
-- unrevoked consent. This table refuses to store one. Two walls, because the
-- failure mode is cloning a person's face and voice without their permission.

CREATE TABLE personas (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- PersonaSpec.id — a slug, authored by hand in YAML. The uuid above is the
    -- database identity; this is the one the agent core and the CLI say out loud.
    slug          text NOT NULL,

    -- NULL = a library persona from the curated synthetic set (§9), usable by
    -- everyone. Non-NULL = this account created it.
    owner_user_id uuid REFERENCES users (id) ON DELETE CASCADE,

    kind          persona_kind NOT NULL,

    -- Identity
    identity_name         text NOT NULL,
    identity_relationship text NOT NULL,
    identity_bio          text,

    -- Speech
    speech_catchphrases text[] NOT NULL DEFAULT '{}',
    speech_fillers      text[] NOT NULL DEFAULT '{}',
    speech_verbosity    speech_verbosity NOT NULL DEFAULT 'medium',
    speech_warmth       trait_level NOT NULL DEFAULT 'medium',
    speech_formality    trait_level NOT NULL DEFAULT 'low',
    speech_humor        text,
    speech_address_as   text,

    -- Pedagogy
    pedagogy_style            teaching_style NOT NULL DEFAULT 'socratic',
    pedagogy_patience         trait_level NOT NULL DEFAULT 'high',
    pedagogy_on_wrong_answer  text NOT NULL
        DEFAULT 'asks what led the learner there before correcting',
    pedagogy_analogy_sources  text[] NOT NULL DEFAULT '{}',
    pedagogy_encouragement    text,

    -- The list that does most of the mimicry work. Order is significant.
    few_shot    jsonb NOT NULL DEFAULT '[]'::jsonb,
    never_does  text[] NOT NULL DEFAULT '{}',

    -- Voice. Optional as a group: PersonaSpec.voice is `VoiceConfig | None`, and
    -- a text-only persona is legal. All five columns move together.
    voice_provider         text,
    voice_id               text,
    voice_model            text,
    voice_stability        numeric(4, 3),
    voice_similarity_boost numeric(4, 3),

    -- Avatar. Always present (default_factory), though avatar_ref may be NULL
    -- until enrollment produces one.
    avatar_provider text NOT NULL DEFAULT 'lemonslice',
    avatar_ref      text,

    -- Consent
    consent_status              consent_status NOT NULL DEFAULT 'not_required',
    consent_recording_uri       text,
    consent_granted_at          timestamptz,
    consent_revoked_at          timestamptz,
    consent_captured_in_session boolean NOT NULL DEFAULT false,

    -- PersonaSpec.is_revoked, materialized so the partial index below can use it.
    is_revoked boolean NOT NULL GENERATED ALWAYS AS (consent_revoked_at IS NOT NULL) STORED,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    -- PersonaSpec.id pattern, verbatim.
    CONSTRAINT personas_slug_shaped CHECK (slug ~ '^[a-z][a-z0-9_-]{1,47}$'),

    CONSTRAINT personas_identity_name_nonempty
        CHECK (length(btrim(identity_name)) > 0),
    CONSTRAINT personas_identity_relationship_nonempty
        CHECK (length(btrim(identity_relationship)) > 0),
    CONSTRAINT personas_on_wrong_answer_nonempty
        CHECK (length(btrim(pedagogy_on_wrong_answer)) > 0),
    CONSTRAINT personas_avatar_provider_nonempty
        CHECK (length(btrim(avatar_provider)) > 0),

    -- pydantic max_length, mirrored.
    CONSTRAINT personas_catchphrases_ok     CHECK (text_list_ok(speech_catchphrases, 8)),
    CONSTRAINT personas_fillers_ok          CHECK (text_list_ok(speech_fillers, 6)),
    CONSTRAINT personas_analogy_sources_ok  CHECK (text_list_ok(pedagogy_analogy_sources, 8)),
    CONSTRAINT personas_never_does_ok       CHECK (text_list_ok(never_does, 10)),
    CONSTRAINT personas_few_shot_ok         CHECK (persona_few_shot_ok(few_shot)),

    -- VoiceConfig is all-or-nothing.
    CONSTRAINT personas_voice_grouped CHECK (
        num_nonnulls(voice_provider, voice_id, voice_model,
                     voice_stability, voice_similarity_boost) IN (0, 5)
    ),
    CONSTRAINT personas_voice_ranges CHECK (
        (voice_stability IS NULL OR voice_stability BETWEEN 0 AND 1)
        AND (voice_similarity_boost IS NULL OR voice_similarity_boost BETWEEN 0 AND 1)
    ),

    -- A persona of someone — self or another person — belongs to an account.
    -- Only the curated synthetic library is ownerless.
    CONSTRAINT personas_nonsynthetic_needs_owner
        CHECK (kind = 'synthetic' OR owner_user_id IS NOT NULL),

    -- ---------------------------------------------------------------------
    -- The one that matters. PersonaSpec._enforce_consent_rules, in SQL.
    -- ---------------------------------------------------------------------
    CONSTRAINT personas_real_person_requires_consent CHECK (
        kind <> 'real_person'
        OR (
            consent_status = 'granted'
            AND consent_captured_in_session
            AND consent_revoked_at IS NULL
        )
    ),

    -- A revocation cannot predate the grant it revokes.
    CONSTRAINT personas_consent_times_ordered CHECK (
        consent_granted_at IS NULL
        OR consent_revoked_at IS NULL
        OR consent_revoked_at >= consent_granted_at
    )
);

-- Slugs are unique per owner; the library namespace is separate, so a learner
-- may have their own "ada" without colliding with the curated one.
CREATE UNIQUE INDEX personas_owner_slug_key
    ON personas (owner_user_id, slug) WHERE owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX personas_library_slug_key
    ON personas (slug) WHERE owner_user_id IS NULL;

CREATE INDEX personas_owner_idx ON personas (owner_user_id) WHERE owner_user_id IS NOT NULL;

-- The loader's hot path: usable personas only (loader.py refuses revoked ones).
CREATE INDEX personas_usable_idx ON personas (kind) WHERE NOT is_revoked;

-- §10 vendor-side deletion sweeps: "which voices/avatars must we delete upstream".
CREATE INDEX personas_revoked_idx ON personas (consent_revoked_at) WHERE is_revoked;

CREATE TRIGGER personas_set_updated_at
    BEFORE UPDATE ON personas
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE personas IS
    'PersonaSpec (apps/agent/.../persona/spec.py) at rest. Round-trips without loss.';
COMMENT ON COLUMN personas.slug IS
    'PersonaSpec.id — the authored slug, e.g. "coach-rios".';
COMMENT ON COLUMN personas.consent_captured_in_session IS
    '§9: true only when voice and photo were captured inside the consent session. '
    'Uploaded third-party media is rejected by design.';
COMMENT ON CONSTRAINT personas_real_person_requires_consent ON personas IS
    'Second wall for PersonaSpec._enforce_consent_rules: a real-person persona '
    'requires granted + in-session-captured + unrevoked consent.';
