# migrations

Numbered, forward-only, one concern per migration, `.up.sql` + `.down.sql`.
Never edit a migration that has been applied anywhere — add a new one.

Applied and rolled back by `../scripts/migrate.sh`. Each runs in a single
transaction with its ledger row.

## Rules

- **Timestamps are `timestamptz`.** No exceptions, no naive columns.
- **Name every constraint.** `CONSTRAINT tablename_what_it_means CHECK (...)`.
  An anonymous constraint gives an error message nobody can act on.
- **A `CHECK` that evaluates to NULL passes.** Reaching into jsonb with `->`
  yields SQL NULL for a missing key, and `jsonb_typeof(NULL) = 'string'` is NULL,
  not false. Use `IS NOT DISTINCT FROM` or guard explicitly. See
  `sim_specs_has_template` in 0009 — it was written the wrong way first.
- **Enum members are added by a new migration** carrying `ALTER TYPE ... ADD
  VALUE`, never by editing `0002_common.up.sql`.
- **Mirror, don't invent.** Enums and length limits here mirror
  `apps/agent/src/tutor_agent/`. Where the Python side validates something, this
  schema is the second wall — calibrated to accept exactly what pydantic accepts,
  so a valid model can never be unstorable.
- **Every `.up.sql` needs a `.down.sql` that fully reverses it.**
  `migrate.sh verify-empty` checks that rolling everything back leaves no table,
  view, sequence, enum, function, or extension behind.

## Order

| # | migration | contains |
| --- | --- | --- |
| 0001 | extensions | `vector` (pgvector, for deferred `doc_chunks`), `citext` |
| 0002 | common | enum types, `set_updated_at()`, the immutable CHECK helpers |
| 0003 | users | accounts, 18+ attestation, soft delete |
| 0004 | interest_profiles | vetted taxonomy keys per user |
| 0005 | personas | `PersonaSpec` at rest + the consent constraints |
| 0006 | sessions | one conversation on one channel |
| 0007 | turns | exchanges, keyed by the core's `t_NNNN` turn ref |
| 0008 | canvas_snapshots | tldraw store snapshots |
| 0009 | sim_specs | analogy-engine specs + seeds, for deterministic replay |
| 0010 | event_log | append-only ops/product events |
| 0011 | content_sources | `merge_linked_accounts` (sync plane) + `uploads` (direct) |
| 0012 | doc_chunks | the retrieval index: pgvector + query-time ACLs |

Next free number: **0013**. Still unbuilt: `tool_call_log`, `study_tasks`,
`channel_identities`, `asset_packs` — see `../README.md` for what each will need.

## Two traps 0012 hit, recorded so the next one doesn't

**A generated column must be IMMUTABLE, and casting text to an enum is not.**
`acl_mode` was `chunk_acl_mode GENERATED ALWAYS AS ((acl ->> 'mode')::chunk_acl_mode)`
and Postgres rejected it with `generation expression is not immutable` — enum
labels can be renamed, so the cast is only STABLE. It is a plain `text` column
with a named CHECK instead. Prefer the enum everywhere else; it cannot work here.

**Numbering collides silently across branches.** The ledger keys on the numeric
prefix, so two branches that both add an `0011_` leave whichever applied first
recorded as "0011" and the other permanently skipped — `status` will even print
your filename against their applied row. Check `SELECT name FROM
schema_migrations` against a shared database before picking a number.
