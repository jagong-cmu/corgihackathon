-- 0006_sessions — one tutoring conversation on one channel.
--
-- §8: "a text exchange and a web session share memory". Sessions are therefore
-- unified across channels by user_id, not partitioned per channel — the channel
-- is an attribute of the session, never a separate table.

CREATE TABLE sessions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    -- NO ACTION, not RESTRICT: deleting a user cascades to their sessions and
    -- their personas in the same statement, and NO ACTION defers the check to
    -- statement end so that ordering does not matter. A library persona still
    -- cannot be deleted out from under someone else's session history.
    persona_id   uuid NOT NULL REFERENCES personas (id) ON DELETE NO ACTION,

    channel      session_channel NOT NULL,
    started_at   timestamptz NOT NULL DEFAULT now(),
    ended_at     timestamptz,
    subject_hint text,

    -- Free-form per-channel handle: a LiveKit room name on web, a Photon thread
    -- id on messaging. Opaque to the schema on purpose.
    channel_ref  text,

    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT sessions_ends_after_start CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX sessions_user_recent_idx ON sessions (user_id, started_at DESC);
CREATE INDEX sessions_persona_idx ON sessions (persona_id);

-- "is this learner already live somewhere" — the barge-in / reconnect path.
CREATE INDEX sessions_open_idx ON sessions (user_id, channel) WHERE ended_at IS NULL;

-- One channel handle maps to at most one live session.
CREATE UNIQUE INDEX sessions_open_channel_ref_key
    ON sessions (channel, channel_ref) WHERE channel_ref IS NOT NULL AND ended_at IS NULL;

COMMENT ON COLUMN sessions.subject_hint IS
    'What the learner said they wanted to work on. A hint for context assembly, not a taxonomy.';
COMMENT ON COLUMN sessions.channel_ref IS
    'Channel-native handle: LiveKit room, Photon thread/call id. Opaque here.';
