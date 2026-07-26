-- 0009_sim_specs — every simulation the analogy engine was asked to build.
--
-- §6.4 makes determinism a hard requirement: same spec + same seed => identical
-- event timeline. That property is only useful if the spec and the seed are both
-- durable, so seed is a column rather than something the client keeps.
--
-- template and theme are generated from the spec instead of being written twice.
-- They exist because §6.3 says recurring p5_sketch escape-hatch uses get promoted
-- into real templates — which requires being able to count them.

CREATE TABLE sim_specs (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    turn_id    uuid REFERENCES turns (id) ON DELETE SET NULL,

    -- The `id` the model gave the shape in spawn_sim, so sim_control/sim_update
    -- on a later turn resolve to this row.
    shape_ref  text,

    spec       jsonb NOT NULL,
    seed       bigint NOT NULL DEFAULT 0,

    template   text GENERATED ALWAYS AS (spec ->> 'template') STORED,
    theme      text GENERATED ALWAYS AS (spec ->> 'theme') STORED,

    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT sim_specs_is_object CHECK (jsonb_typeof(spec) = 'object'),

    -- §6.2: template is what makes a spec resolvable in the registry. A spec
    -- without one is unrenderable, so it never reaches storage.
    --
    -- IS NOT DISTINCT FROM, not =: a missing key makes `spec -> 'template'` SQL
    -- NULL, jsonb_typeof(NULL) is NULL, and a CHECK that evaluates to NULL
    -- PASSES. The exact spec this constraint exists to reject would have been
    -- the one it let through.
    CONSTRAINT sim_specs_has_template
        CHECK (jsonb_typeof(spec -> 'template') IS NOT DISTINCT FROM 'string')
);

CREATE INDEX sim_specs_session_idx ON sim_specs (session_id, created_at);
CREATE INDEX sim_specs_template_idx ON sim_specs (template);
CREATE UNIQUE INDEX sim_specs_session_shape_key
    ON sim_specs (session_id, shape_ref) WHERE shape_ref IS NOT NULL;

COMMENT ON TABLE sim_specs IS
    'Analogy-engine specs for replay and caching (§6). Deterministic given (spec, seed).';
COMMENT ON COLUMN sim_specs.seed IS
    '§6.4: seeded randomness, fixed timestep, no wall-clock dependence.';
COMMENT ON COLUMN sim_specs.template IS
    'Registry template id, derived from the spec. Count p5_sketch here to find promotion candidates.';
