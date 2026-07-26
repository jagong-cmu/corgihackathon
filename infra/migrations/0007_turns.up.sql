-- 0007_turns — one exchange inside a session.
--
-- turn_ref is the id the agent core mints (core/session.py: `t_0001`) and stamps
-- onto every canvas_action frame on the wire (§4). Without it stored, nothing
-- downstream — sim_specs, event_log, a replayed board — can be tied back to the
-- turn that produced it, so it is a first-class column and unique per session.
--
-- started_ms is the §11 field: an offset into the session, not a wall clock.
-- Cue times are relative to a turn's audio, turns are relative to the session,
-- and only the session anchors to real time. Keeping the same frame of reference
-- here is what makes a replay reproducible.

CREATE TABLE turns (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,

    turn_ref    text NOT NULL,
    role        turn_role NOT NULL,
    transcript  text NOT NULL,

    started_ms  integer NOT NULL,
    duration_ms integer,

    audio_uri   text,

    -- TurnResult, minus what lives in sim_specs/event_log. A turn cut short by
    -- barge-in is kept, because "the tutor was interrupted here" is teaching
    -- signal, not noise.
    stop_reason text,
    cancelled   boolean NOT NULL DEFAULT false,

    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT turns_ref_shaped     CHECK (turn_ref ~ '^t_[0-9]{4,}$'),
    CONSTRAINT turns_started_ms_ok  CHECK (started_ms >= 0),
    CONSTRAINT turns_duration_ok    CHECK (duration_ms IS NULL OR duration_ms >= 0),

    -- Only the tutor speaks with a synthesized voice; a student audio_uri would
    -- mean raw learner audio at rest, which §10 deliberately avoids.
    CONSTRAINT turns_audio_is_tutor_only CHECK (audio_uri IS NULL OR role = 'tutor')
);

CREATE UNIQUE INDEX turns_session_ref_key ON turns (session_id, turn_ref);
CREATE INDEX turns_session_order_idx ON turns (session_id, started_ms);

COMMENT ON COLUMN turns.turn_ref IS
    'The agent core''s per-session turn id (t_0142). Carried on every wire frame (§4).';
COMMENT ON COLUMN turns.started_ms IS
    'Offset from sessions.started_at, in ms. Not a wall clock — replays depend on this.';
COMMENT ON COLUMN turns.role IS
    'student | tutor | system. The core maps its LLM roles onto these at persist time.';
