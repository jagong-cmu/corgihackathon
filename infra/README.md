# infra — Postgres schema and migrations

Local Postgres 16 (+pgvector) and the forward-only SQL migrations for the
Personal AI Tutor. No ORM: the DDL is the schema.

```
infra/
  docker-compose.yml       postgres 16 + pgvector, a migrate runner, a seed runner
  Makefile                 the commands below
  migrations/NNNN_*.up.sql   forward migration
  migrations/NNNN_*.down.sql its rollback
  scripts/migrate.sh       the runner (up / down / status / redo / verify-empty)
  scripts/seed.py          persona seed + round-trip assertion + consent probes
  docker/seed.Dockerfile   python image for the seed runner
```

## Quick start

```bash
cd infra
make up      # postgres + all migrations
make seed    # load the YAML personas, assert they round-trip, probe the constraints
make test    # the full check: reset, seed, roll everything back, prove empty, re-apply
```

`docker compose up` on its own does the same as `make up`: the `migrate` service
waits for the healthcheck, applies everything pending, and exits 0.

Nothing needs to be installed on the host except Docker. `migrate.sh` uses a
local `psql` if you have one and the compose container if you don't; `seed.py`
runs in its own image.

| command | what it does |
| --- | --- |
| `make up` | start Postgres, apply all pending migrations |
| `make migrate` | apply pending migrations |
| `make rollback N=3` | roll back the last 3 (default 1) |
| `make status` | applied/pending checklist |
| `make seed` | seed personas + round-trip + consent probes |
| `make demo` | the above, plus a demo user, session, turns, snapshot, sim, event |
| `make verify` | roll everything back and assert the database is empty |
| `make reset` | drop the volume and rebuild |
| `make psql` | a shell |

Connection string: `postgres://tutor:tutor@localhost:5432/tutor`. Override with
`POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `POSTGRES_PORT`, or point
everything elsewhere with `DATABASE_URL`.

## How migrations work

Numbered, forward-only, one concern each, `.up.sql` + `.down.sql`. Each migration
runs inside a single transaction together with its bookkeeping row, so a failure
leaves neither half-applied DDL nor a lying ledger.

The ledger (`schema_migrations`) is created by the runner rather than by
migration 0001, so that rolling every migration back can drop it too — `make
verify` then checks that no table, view, sequence, enum type, function, or
extension survives in `public`. "Rollback leaves an empty database" is a claim
the runner proves rather than one you take on faith.

To add a table: write `0011_thing.up.sql` and `0011_thing.down.sql`. Never edit
an applied migration. Enum members are added with a new migration carrying
`ALTER TYPE ... ADD VALUE`, never by editing `0002_common`.

## What is here

| migration | tables |
| --- | --- |
| 0001 | extensions: `vector`, `citext` |
| 0002 | enum types + the immutable helpers the CHECKs use |
| 0003 | `users` |
| 0004 | `interest_profiles` |
| 0005 | `personas` |
| 0006 | `sessions` |
| 0007 | `turns` |
| 0008 | `canvas_snapshots` |
| 0009 | `sim_specs` |
| 0010 | `event_log` |
| 0011 | `merge_linked_accounts`, `uploads` — the two provenance roots |
| 0012 | `doc_chunks` — the retrieval index |
| 0013 | `blobs` + persona lifecycle columns |

### personas round-trips PersonaSpec

`apps/agent/src/tutor_agent/persona/spec.py` is the authority. Every field of
`PersonaSpec` — identity, speech, pedagogy, few_shot, never_does, voice, avatar,
consent — has a home here, and `make seed` proves it: it loads the YAML with the
agent's own loader, writes it, reads it back, re-validates it as a `PersonaSpec`,
and diffs the two model dumps. A field added to the pydantic model without a
column turns that into a failing check.

Nested objects are flattened into columns (`speech_verbosity`, `voice_id`,
`consent_status`, …) rather than stored as one jsonb blob, because that is what
lets the database constrain them. `few_shot` stays jsonb: it is an ordered list
of small records that is only ever read whole. Its shape — including
`extra="forbid"` — is still checked, by `persona_few_shot_ok()`.

### Consent is enforced by the database

`PersonaSpec._enforce_consent_rules` refuses to *construct* a real-person persona
without granted, captured-in-session, unrevoked consent.
`personas_real_person_requires_consent` refuses to *store* one:

```sql
CHECK (kind <> 'real_person'
       OR (consent_status = 'granted'
           AND consent_captured_in_session
           AND consent_revoked_at IS NULL))
```

Plus `personas_nonsynthetic_needs_owner` (only the curated synthetic library is
ownerless) and `personas_consent_times_ordered` (a revocation cannot predate its
grant). `make seed` fires seven probes at these constraints — six that must be
rejected, one that must be accepted — and fails if any lands the wrong way.

The DB is deliberately calibrated to accept exactly what pydantic accepts and
reject exactly what it rejects, so a valid `PersonaSpec` can never be unstorable.
That is why `consent_recording_uri` is *not* required for `real_person` even
though §9 says recordings are retained: the Python model does not require it, and
the two walls must not disagree. Make it a `NOT NULL` here only in the same
change that makes it required there.

## Deviations from the §11 sketch

The README calls §11 a sketch. These are the places it was underspecified, and
what was done instead:

1. **Surrogate keys vs. slugs.** `PersonaSpec.id` is an authored slug
   (`coach-rios`). Tables get a uuid `id` and personas keep the slug in `slug`,
   unique per owner, with a separate library namespace for ownerless synthetic
   personas — so two learners can both have a persona called `mom`.
2. **`personas.style jsonb` is expanded.** The sketch's single `style` blob is
   the spec's `speech` + `pedagogy` + `few_shot` + `never_does`. Only `few_shot`
   remained jsonb; everything else became a column with a constraint.
3. **`interest_profiles` is keyed by `user_id`.** One profile per user is the
   real cardinality, so there is no surrogate id. The interests array is checked
   against a taxonomy-key shape, because §6.5 forbids raw user text from reaching
   an image-generation prompt and that rule needed somewhere to actually live.
4. **`turns.turn_ref` added.** The agent core mints `t_0142` per session and
   stamps it on every wire frame (§4). Without storing it, nothing downstream can
   be tied back to the turn that produced it.
5. **`turns` gained `duration_ms`, `stop_reason`, `cancelled`** — the rest of
   `TurnResult`. A turn cut short by barge-in is kept: "the tutor was interrupted
   here" is teaching signal.
6. **`turns.role` is `student | tutor | system`,** not the core's LLM-side
   `user`/`assistant`. Adapters map at persist time.
7. **`sim_specs` gained `seed`, `shape_ref`, and generated `template`/`theme`.**
   §6.4 makes determinism a hard requirement, which is meaningless unless the
   seed is durable. `shape_ref` is the id from `spawn_sim`, so a later
   `sim_control` resolves to a row. `template` is generated from the spec so
   recurring `p5_sketch` escape-hatch uses can be counted for promotion (§6.3).
8. **`event_log` gained `user_id` and `turn_id`.** Consent revocations and
   ingestion events have a user but no session; a session-only column would have
   forced those into a second table.
9. **`event_log.kind` is text, not an enum,** with a dotted-namespace pattern
   check. A log whose every new event type needs a migration and a deploy
   ordering is a log people route around.
10. **`canvas_snapshots` gained `turn_id` and `reason`.** The board is the
    learner's reviewable notes (§5.2), so knowing *why* a snapshot exists —
    especially `new_section`, the natural review unit — is product data.
11. **`users.adult_attested_at`** records the §10 18+ attestation as a timestamp
    rather than a boolean, because "when did they attest" is the question a
    compliance review asks. It is nullable so a half-finished signup can persist;
    application code must refuse to open a session while it is NULL.
12. **Soft delete on `users`.** `deleted_at` plus a partial unique index on
    email, so a soft-deleted account keeps its history without blocking re-signup.
    A §10 erasure request is a real `DELETE`, which cascades.
13. **`sessions.channel_ref`** — the channel-native handle (LiveKit room, Photon
    thread) — with a unique index over live sessions, so one thread maps to at
    most one open session.
14. **`sessions.persona_id` is `ON DELETE NO ACTION`,** not RESTRICT: deleting a
    user cascades to their sessions and personas in one statement, and NO ACTION
    defers the check to statement end so the order does not matter. A library
    persona still cannot be deleted out from under someone else's history.

Enum members were not invented beyond what the code declares.
`session_channel` is exactly `core/channel.py`'s `Channel` — web, imessage, sms,
whatsapp, phone. README §8 also names Telegram, Slack, and Discord as Photon
targets; they are deliberately absent until that enum grows them, so the two
cannot drift.

### uploads and doc_chunks are live

`POST /materials` on the API writes an `uploads` row and calls
`PgVectorRetrieval.upsert_document`, so a learner's document becomes chunks the
worker can retrieve in-loop. `apps/api/tests/test_materials.py` runs that path
against this schema and asserts the parts the constraints exist to guarantee:
exactly one provenance root per chunk, re-upload replacing rather than
duplicating, and a delete that purges the chunks rather than only hiding the
row.

## Deferred to Phase 5/6/7 — not built yet

These are in the §11 sketch and are intentionally absent. The extensions and
foreign-key targets they need are already in place, so each is an additive
migration with no rework.

| table | phase | notes for whoever builds it |
| --- | --- | --- |
| `tool_call_log` | 5 | Mirrors Merge Agent Handler call metadata for our own analytics (§7.2). Plane sync/action, connector, tool, status, latency_ms, merge_log_ref. |
| `study_tasks` | 5 | Ticketing-category study planner (§7.2). |
| `channel_identities` | 6 | Photon opt-in/opt-out per address. §10 makes `opt_in_at` load-bearing, not decorative — no outbound message without it. |
| `asset_packs` | 7 | fal.ai sprite packs keyed by `(user_id, theme)`; theme comes from `interest_profiles.interests`, so the taxonomy check in 0004 is its upstream guarantee. |

## Conventions

- Every timestamp is `timestamptz`. The container runs UTC. There are no naive
  timestamps anywhere, and the two "ms" columns (`turns.started_ms`,
  cue offsets) are deliberately *offsets*, not clocks — replays depend on it.
- Constraints are named. An anonymous constraint produces an error message no one
  can act on.
- `CHECK` and NULL: a check that evaluates to NULL **passes**. Any check reaching
  into jsonb with `->` must use `IS NOT DISTINCT FROM` or an explicit NULL guard.
  `sim_specs_has_template` was written the wrong way first and let exactly the
  spec it existed to reject slip through.
