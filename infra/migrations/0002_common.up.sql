-- 0002_common — enum types and the immutable helpers the CHECK constraints use.
--
-- Every enum here mirrors a StrEnum in apps/agent. The Python side is the
-- authority on meaning; this file is the second wall. When a StrEnum gains a
-- member, add a migration with `ALTER TYPE ... ADD VALUE` — never edit this one.

-- persona/spec.py :: PersonaKind
CREATE TYPE persona_kind AS ENUM ('synthetic', 'self', 'real_person');

-- persona/spec.py :: Consent.status (a plain str field there, an enum here —
-- the four legal values are documented in the field description).
CREATE TYPE consent_status AS ENUM ('not_required', 'pending', 'granted', 'revoked');

-- persona/spec.py :: Verbosity
CREATE TYPE speech_verbosity AS ENUM ('terse', 'medium', 'expansive');

-- persona/spec.py :: Level (shared by Speech.warmth/formality and Pedagogy.patience)
CREATE TYPE trait_level AS ENUM ('low', 'medium', 'high');

-- persona/spec.py :: TeachingStyle
CREATE TYPE teaching_style AS ENUM ('socratic', 'direct', 'worked_example', 'story');

-- core/channel.py :: Channel. README §8 also names telegram/slack/discord as
-- Photon targets; they are deliberately absent until the agent core's Channel
-- enum grows them, so the two enums cannot drift.
CREATE TYPE session_channel AS ENUM ('web', 'imessage', 'sms', 'whatsapp', 'phone');

-- The agent core speaks the LLM's vocabulary ("user"/"assistant"); the durable
-- record speaks the product's. Adapters map user->student, assistant->tutor.
CREATE TYPE turn_role AS ENUM ('student', 'tutor', 'system');


-- Touch trigger. Applied to every table carrying updated_at.
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;


-- A text[] that is non-null, one-dimensional, free of NULL elements, and no
-- longer than the pydantic max_length for that field.
CREATE FUNCTION text_list_ok(v text[], max_len integer) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT v IS NOT NULL
       AND coalesce(array_ndims(v), 1) = 1
       AND coalesce(array_length(v, 1), 0) <= max_len
       AND array_position(v, NULL) IS NULL;
$$;


-- PersonaSpec.few_shot: a list[Exchange] where Exchange is
-- {student: str, tutor: str, note: str | None} with extra="forbid".
CREATE FUNCTION persona_few_shot_ok(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT jsonb_typeof(v) = 'array'
       AND jsonb_array_length(v) <= 12
       AND NOT EXISTS (
           SELECT 1
           FROM jsonb_array_elements(v) AS e
           WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
              OR jsonb_typeof(e -> 'student') IS DISTINCT FROM 'string'
              OR jsonb_typeof(e -> 'tutor') IS DISTINCT FROM 'string'
              OR jsonb_typeof(e -> 'note') NOT IN ('string', 'null')
              OR EXISTS (
                     SELECT 1 FROM jsonb_object_keys(e) AS k
                     WHERE k NOT IN ('student', 'tutor', 'note')
                 )
       );
$$;


-- interest_profiles.interests: an array of vetted-taxonomy keys, never raw user
-- text. §6.5 forbids interpolating free text into image prompts, so the shape of
-- a taxonomy key is enforced here rather than trusted from the caller.
CREATE FUNCTION taxonomy_key_array_ok(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT jsonb_typeof(v) = 'array'
       AND NOT EXISTS (
           SELECT 1
           FROM jsonb_array_elements(v) AS e
           WHERE jsonb_typeof(e) IS DISTINCT FROM 'string'
              OR (e #>> '{}') !~ '^[a-z][a-z0-9_]{1,39}$'
       );
$$;
