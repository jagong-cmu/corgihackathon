-- 0010_event_log — the append-only record of what happened.
--
-- §13: "on validation failure, drop, log to event_log, continue." A dropped
-- canvas action is invisible to the learner by design, which means this table is
-- the only place the failure is visible to us. §6.3 also routes every p5_sketch
-- escape-hatch use here, since recurring uses are what get promoted to templates.
--
-- kind is text, not an enum: this is a log, and every new event type would
-- otherwise need a migration and a deploy ordering. The pattern check keeps the
-- namespace from rotting into free text.

CREATE TABLE event_log (
    id         bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,

    -- Both nullable: consent revocation and ingestion events have a user but no
    -- session; worker-level events have neither.
    session_id uuid REFERENCES sessions (id) ON DELETE CASCADE,
    user_id    uuid REFERENCES users (id) ON DELETE CASCADE,

    turn_id    uuid REFERENCES turns (id) ON DELETE SET NULL,

    kind       text NOT NULL,
    payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
    at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT event_log_kind_shaped CHECK (kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
    CONSTRAINT event_log_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),

    -- A turn belongs to a session; an event that names one must name the other.
    CONSTRAINT event_log_turn_needs_session CHECK (turn_id IS NULL OR session_id IS NOT NULL)
);

CREATE INDEX event_log_session_idx ON event_log (session_id, at DESC) WHERE session_id IS NOT NULL;
CREATE INDEX event_log_user_idx ON event_log (user_id, at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX event_log_kind_idx ON event_log (kind, at DESC);
CREATE INDEX event_log_payload_gin ON event_log USING gin (payload jsonb_path_ops);

COMMENT ON TABLE event_log IS
    'Append-only product/ops event stream. Dotted kinds, e.g. action.dropped, sim.escape_hatch_used.';
COMMENT ON COLUMN event_log.kind IS
    'Dotted lowercase namespace: action.dropped | turn.barge_in | sim.escape_hatch_used | '
    'consent.revoked | avatar.paused.';
