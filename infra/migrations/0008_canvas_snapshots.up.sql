-- 0008_canvas_snapshots — the board, at rest.
--
-- §13: "Do not introduce browser localStorage for session state (canvas state
-- lives in tldraw snapshots + Postgres)." This table is the Postgres half. The
-- board doubles as the learner's reviewable notes (§5.2), so snapshots are
-- durable product data, not a debug artifact.

CREATE TABLE canvas_snapshots (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,

    -- Which turn the board looked like this after. NULL for a periodic autosave
    -- that did not land on a turn boundary.
    turn_id         uuid REFERENCES turns (id) ON DELETE SET NULL,

    taken_at        timestamptz NOT NULL DEFAULT now(),
    reason          text NOT NULL DEFAULT 'autosave',
    tldraw_snapshot jsonb NOT NULL,

    CONSTRAINT canvas_snapshots_is_object CHECK (jsonb_typeof(tldraw_snapshot) = 'object'),
    CONSTRAINT canvas_snapshots_reason_ok
        CHECK (reason IN ('autosave', 'turn_end', 'new_section', 'session_end', 'manual'))
);

CREATE INDEX canvas_snapshots_session_idx ON canvas_snapshots (session_id, taken_at DESC);
CREATE INDEX canvas_snapshots_turn_idx ON canvas_snapshots (turn_id) WHERE turn_id IS NOT NULL;

COMMENT ON COLUMN canvas_snapshots.tldraw_snapshot IS
    'A tldraw store snapshot including custom shapes (Equation/Graph/Simulation/Steps/Media/Source).';
COMMENT ON COLUMN canvas_snapshots.reason IS
    'Why this snapshot exists. new_section marks a section boundary, which is the natural review unit.';
