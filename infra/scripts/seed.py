#!/usr/bin/env python3
"""Seed the personas library and prove the round-trip.

This is a test disguised as a seed script. It loads the YAML personas with the
same loader the agent uses, writes them through the schema, reads them back,
re-validates them as PersonaSpec, and asserts the two objects are identical. If
the schema ever loses a field — a new pydantic model, a column someone forgot —
this fails loudly instead of silently shipping a tutor missing half its voice.

It then probes the consent CHECK constraints directly (--probe, on by default),
because "the DB is the second wall" is a claim worth testing rather than
asserting. Each probe runs in a savepoint and is rolled back.

    python seed.py                 # seed + round-trip + constraint probes
    python seed.py --demo          # also insert a demo user and one full session
    python seed.py --no-probe      # skip the constraint probes
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENT_SRC = REPO_ROOT / "apps" / "agent" / "src"
PERSONA_DIR = REPO_ROOT / "apps" / "agent" / "personas"

# apps/agent is owned by another session; we import from it, never into it.
sys.path.insert(0, str(AGENT_SRC))

from tutor_agent.persona.loader import load_persona_dir  # noqa: E402
from tutor_agent.persona.spec import PersonaSpec  # noqa: E402

# Promoted into apps/agent so there is exactly one definition of the mapping.
from tutor_agent.persona.store import normalized, row_to_spec, spec_to_row  # noqa: E402

DEFAULT_DSN = "postgres://tutor:tutor@localhost:5432/tutor"


def upsert_persona(conn: psycopg.Connection, spec: PersonaSpec) -> None:
    """Library personas (owner_user_id IS NULL) are keyed by slug."""
    row = spec_to_row(spec)
    cols = list(row)
    placeholders = ", ".join(f"%({c})s" for c in cols)
    updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols if c != "slug")
    conn.execute(
        f"INSERT INTO personas ({', '.join(cols)}) VALUES ({placeholders}) "
        f"ON CONFLICT (slug) WHERE owner_user_id IS NULL AND deleted_at IS NULL "
        f"DO UPDATE SET {updates}",
        row,
    )


def fetch_persona(conn: psycopg.Connection, slug: str) -> dict[str, Any]:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            "SELECT * FROM personas "
            "WHERE slug = %s AND owner_user_id IS NULL AND deleted_at IS NULL",
            (slug,),
        )
        found = cur.fetchone()
    if found is None:
        raise AssertionError(f"persona {slug!r} vanished after insert")
    return found


# --------------------------------------------------------------------------
# constraint probes — the second wall, tested
# --------------------------------------------------------------------------

BASE_REAL_PERSON = {
    "slug": "probe-real-person",
    "kind": "real_person",
    "identity_name": "Probe",
    "identity_relationship": "the learner's parent",
    "avatar_provider": "lemonslice",
}


def _probe(
    conn: psycopg.Connection,
    label: str,
    overrides: dict[str, Any],
    *,
    owner_user_id: str | None,
    expect_rejected: bool,
) -> bool:
    row = {**BASE_REAL_PERSON, **overrides, "owner_user_id": owner_user_id}
    cols = list(row)
    stmt = (
        f"INSERT INTO personas ({', '.join(cols)}) "
        f"VALUES ({', '.join(f'%({c})s' for c in cols)})"
    )
    with conn.transaction():  # a savepoint — every probe is rolled back
        try:
            conn.execute(stmt, row)
        except psycopg.errors.CheckViolation as exc:
            constraint = getattr(exc.diag, "constraint_name", None) or "?"
            ok = expect_rejected
            print(f"  {'PASS' if ok else 'FAIL'}  {label} -> rejected by {constraint}")
            raise _Rollback(ok) from None
        ok = not expect_rejected
        verb = "accepted" if ok else "ACCEPTED (should have been rejected)"
        print(f"  {'PASS' if ok else 'FAIL'}  {label} -> {verb}")
        raise _Rollback(ok)


class _Rollback(Exception):
    def __init__(self, ok: bool) -> None:
        self.ok = ok


def probe(conn: psycopg.Connection, label: str, overrides: dict[str, Any], **kw: Any) -> bool:
    try:
        _probe(conn, label, overrides, **kw)
    except _Rollback as r:
        return r.ok
    return False


def run_probes(conn: psycopg.Connection) -> bool:
    """Mirror of PersonaSpec._enforce_consent_rules, from the other side."""
    owner = conn.execute(
        "INSERT INTO users (email, adult_attested_at) VALUES ('probe@example.test', now()) "
        "ON CONFLICT DO NOTHING RETURNING id"
    ).fetchone()
    if owner is None:
        owner = conn.execute(
            "SELECT id FROM users WHERE email = 'probe@example.test'"
        ).fetchone()
    owner_id = str(owner[0])

    granted = {
        "consent_status": "granted",
        "consent_captured_in_session": True,
        "consent_granted_at": "2026-07-01T00:00:00+00:00",
        "consent_recording_uri": "s3://consent/probe.webm",
    }

    print("consent constraint probes (real_person):")
    results = [
        probe(conn, "no consent at all", {}, owner_user_id=owner_id, expect_rejected=True),
        probe(
            conn,
            "consent pending",
            {**granted, "consent_status": "pending"},
            owner_user_id=owner_id,
            expect_rejected=True,
        ),
        probe(
            conn,
            "granted but media uploaded, not captured in-session",
            {**granted, "consent_captured_in_session": False},
            owner_user_id=owner_id,
            expect_rejected=True,
        ),
        # Changed in migration 0013. This used to expect rejection, which made
        # the revoked state unrepresentable for exactly the personas revocation
        # exists for — §9 makes a persona revocable at any time, and §10 needs a
        # sweep that FINDS revoked personas to delete their voice and avatar
        # vendor-side. A row that cannot exist cannot be swept.
        #
        # The guarantee that matters is unchanged and still probed above: you
        # cannot CREATE a real-person persona without granted, in-session
        # consent. Refusing to SERVE a revoked one is the application's job
        # (persona.loader.get_persona), not a CHECK constraint's.
        probe(
            conn,
            "granted then revoked -> stays representable for the §10 sweep",
            {
                **granted,
                "consent_status": "revoked",
                "consent_revoked_at": "2026-07-02T00:00:00+00:00",
            },
            owner_user_id=owner_id,
            expect_rejected=False,
        ),
        probe(
            conn,
            "revoked before granted",
            {**granted, "consent_revoked_at": "2026-06-01T00:00:00+00:00"},
            owner_user_id=owner_id,
            expect_rejected=True,
        ),
        probe(
            conn,
            "granted, in-session, unrevoked but ownerless",
            granted,
            owner_user_id=None,
            expect_rejected=True,
        ),
        probe(
            conn,
            "granted, in-session, unrevoked, owned",
            granted,
            owner_user_id=owner_id,
            expect_rejected=False,
        ),
    ]
    conn.execute("DELETE FROM users WHERE email = 'probe@example.test'")
    return all(results)


# --------------------------------------------------------------------------
# optional demo session — exercises the rest of the schema end to end
# --------------------------------------------------------------------------


def seed_demo(conn: psycopg.Connection) -> None:
    user_id = conn.execute(
        """
        INSERT INTO users (email, display_name, adult_attested_at)
        VALUES ('demo@example.test', 'Demo Learner', now())
        ON CONFLICT (email) WHERE deleted_at IS NULL DO UPDATE SET display_name = EXCLUDED.display_name
        RETURNING id
        """
    ).fetchone()[0]

    conn.execute(
        """
        INSERT INTO interest_profiles (user_id, interests)
        VALUES (%s, %s)
        ON CONFLICT (user_id) DO UPDATE SET interests = EXCLUDED.interests
        """,
        (user_id, Jsonb(["basketball", "cooking"])),
    )

    persona_id = conn.execute(
        "SELECT id FROM personas WHERE slug = 'ada' AND owner_user_id IS NULL"
    ).fetchone()[0]

    conn.execute("DELETE FROM sessions WHERE user_id = %s", (user_id,))
    session_id = conn.execute(
        """
        INSERT INTO sessions (user_id, persona_id, channel, subject_hint, channel_ref)
        VALUES (%s, %s, 'web', %s, 'room_demo')
        RETURNING id
        """,
        (user_id, persona_id, "newton's third law"),
    ).fetchone()[0]

    student_turn = conn.execute(
        """
        INSERT INTO turns (session_id, turn_ref, role, transcript, started_ms)
        VALUES (%s, 't_0001', 'student', 'Why do both balls push on each other?', 0)
        RETURNING id
        """,
        (session_id,),
    ).fetchone()[0]

    tutor_turn = conn.execute(
        """
        INSERT INTO turns (session_id, turn_ref, role, transcript, started_ms,
                           duration_ms, audio_uri, stop_reason)
        VALUES (%s, 't_0002', 'tutor',
                'Mm. Watch what happens when this one hits the other.',
                1400, 3200, 's3://audio/demo/t_0002.mp3', 'end_turn')
        RETURNING id
        """,
        (session_id,),
    ).fetchone()[0]

    conn.execute(
        """
        INSERT INTO sim_specs (session_id, turn_id, shape_ref, spec, seed)
        VALUES (%s, %s, 'sim_collision_1', %s, 42)
        """,
        (
            session_id,
            tutor_turn,
            Jsonb(
                {
                    "template": "collision_2body",
                    "theme": "basketball",
                    "objects": [
                        {"sprite": "basketball", "label": "Ball A", "mass": 0.62, "v": 4.2},
                        {"sprite": "basketball", "label": "Ball B", "mass": 0.62, "v": 0},
                    ],
                    "params": {"restitution": 0.85},
                    "overlays": ["force_vectors", "momentum_hud"],
                }
            ),
        ),
    )

    conn.execute(
        """
        INSERT INTO canvas_snapshots (session_id, turn_id, reason, tldraw_snapshot)
        VALUES (%s, %s, 'turn_end', %s)
        """,
        (session_id, tutor_turn, Jsonb({"store": {}, "schema": {"schemaVersion": 2}})),
    )

    conn.execute(
        """
        INSERT INTO event_log (session_id, user_id, turn_id, kind, payload)
        VALUES (%s, %s, %s, 'action.dropped', %s)
        """,
        (
            session_id,
            user_id,
            tutor_turn,
            Jsonb({"action": "graph", "errors": ["spec.domain: expected [min, max]"]}),
        ),
    )

    print(f"demo: user={user_id} session={session_id} turns=[{student_turn}, {tutor_turn}]")


# --------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL", DEFAULT_DSN))
    ap.add_argument("--demo", action="store_true", help="also insert a demo user and session")
    ap.add_argument("--no-probe", dest="probe", action="store_false", default=True)
    args = ap.parse_args()

    personas = load_persona_dir(PERSONA_DIR)
    if not personas:
        print(f"no personas found in {PERSONA_DIR}", file=sys.stderr)
        return 1

    ok = True
    with psycopg.connect(args.dsn, autocommit=False) as conn:
        if conn.execute("SELECT to_regclass('public.personas')").fetchone()[0] is None:
            print("personas table missing — run migrate.sh up first", file=sys.stderr)
            return 1

        print(f"seeding {len(personas)} persona(s) from {PERSONA_DIR}:")
        for slug, spec in sorted(personas.items()):
            upsert_persona(conn, spec)
            back = row_to_spec(fetch_persona(conn, slug))
            if normalized(back) == normalized(spec):
                print(f"  PASS  {slug:<12} round-trips ({len(spec.few_shot)} few-shot exchanges)")
            else:
                ok = False
                print(f"  FAIL  {slug}: read-back differs from the YAML")
                _diff(normalized(spec), normalized(back))

        if args.probe:
            ok = run_probes(conn) and ok

        if args.demo:
            seed_demo(conn)

        conn.commit()

    print("seed OK" if ok else "seed FAILED", file=sys.stderr if not ok else sys.stdout)
    return 0 if ok else 1


def _diff(expected: dict[str, Any], actual: dict[str, Any], path: str = "") -> None:
    for key in sorted(set(expected) | set(actual)):
        e, a = expected.get(key), actual.get(key)
        where = f"{path}.{key}" if path else key
        if isinstance(e, dict) and isinstance(a, dict):
            _diff(e, a, where)
        elif e != a:
            print(f"        {where}: yaml={json.dumps(e, default=str)} db={json.dumps(a, default=str)}")


if __name__ == "__main__":
    raise SystemExit(main())
