"""Persona persistence: the mapper, plus a store behind an interface.

The `spec_to_row` / `row_to_spec` mappers were written in `infra/scripts/seed.py`
and are promoted here unchanged in behavior, so there is exactly one definition
of how a `PersonaSpec` becomes a row. The seed script imports them from here.

Two stores implement the same protocol:

    YamlPersonaStore      the persona/*.yaml files — no DB, works offline,
                          what the CLI and the whole test suite use
    PostgresPersonaStore  the `personas` table — what the API writes to

Everything nested is flattened into columns except `few_shot`, which is JSONB.
The DB re-enforces every rule the pydantic model does (see
`personas_real_person_requires_consent` in migration 0005), so a row that
violates consent is rejected twice.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

from .loader import PersonaNotFoundError, load_persona_dir
from .spec import PersonaSpec

if TYPE_CHECKING:
    import psycopg


# ---------------------------------------------------------------------------
# PersonaSpec <-> row
# ---------------------------------------------------------------------------


def _ts_in(value: str | None) -> datetime | None:
    """Consent timestamps are `str` in the spec and timestamptz in the DB."""
    if value is None:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _ts_out(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.isoformat()


def spec_to_row(spec: PersonaSpec) -> dict[str, Any]:
    """Flatten a spec into column values.

    Deliberately emits neither `id` (the uuid PK) nor `owner_user_id` — the
    caller supplies ownership, because the same spec can be a library persona
    (ownerless) or a user's own.
    """
    from psycopg.types.json import Jsonb

    d = spec.model_dump(mode="json")
    voice = d["voice"]
    return {
        "slug": d["id"],
        "kind": d["kind"],
        "identity_name": d["identity"]["name"],
        "identity_relationship": d["identity"]["relationship"],
        "identity_bio": d["identity"]["bio"],
        "speech_catchphrases": d["speech"]["catchphrases"],
        "speech_fillers": d["speech"]["fillers"],
        "speech_verbosity": d["speech"]["verbosity"],
        "speech_warmth": d["speech"]["warmth"],
        "speech_formality": d["speech"]["formality"],
        "speech_humor": d["speech"]["humor"],
        "speech_address_as": d["speech"]["address_as"],
        "pedagogy_style": d["pedagogy"]["style"],
        "pedagogy_patience": d["pedagogy"]["patience"],
        "pedagogy_on_wrong_answer": d["pedagogy"]["on_wrong_answer"],
        "pedagogy_analogy_sources": d["pedagogy"]["analogy_sources"],
        "pedagogy_encouragement": d["pedagogy"]["encouragement"],
        "few_shot": Jsonb(d["few_shot"]),
        "never_does": d["never_does"],
        "voice_provider": voice["provider"] if voice else None,
        "voice_id": voice["voice_id"] if voice else None,
        "voice_model": voice["model"] if voice else None,
        "voice_stability": voice["stability"] if voice else None,
        "voice_similarity_boost": voice["similarity_boost"] if voice else None,
        "avatar_provider": d["avatar"]["provider"],
        "avatar_ref": d["avatar"]["avatar_ref"],
        "consent_status": d["consent"]["status"],
        "consent_recording_uri": d["consent"]["recording_uri"],
        "consent_granted_at": _ts_in(d["consent"]["granted_at"]),
        "consent_revoked_at": _ts_in(d["consent"]["revoked_at"]),
        "consent_captured_in_session": d["consent"]["captured_in_session"],
    }


def row_to_spec(row: dict[str, Any]) -> PersonaSpec:
    """Rebuild a spec from a row. Runs the pydantic validator, so consent rules
    fire on read as well as on write."""
    voice = None
    if row["voice_id"] is not None:
        voice = {
            "provider": row["voice_provider"],
            "voice_id": row["voice_id"],
            "model": row["voice_model"],
            # psycopg returns numeric as Decimal.
            "stability": float(row["voice_stability"]),
            "similarity_boost": float(row["voice_similarity_boost"]),
        }
    return PersonaSpec.model_validate(
        {
            "id": row["slug"],
            "kind": row["kind"],
            "identity": {
                "name": row["identity_name"],
                "relationship": row["identity_relationship"],
                "bio": row["identity_bio"],
            },
            "speech": {
                "catchphrases": row["speech_catchphrases"],
                "fillers": row["speech_fillers"],
                "verbosity": row["speech_verbosity"],
                "warmth": row["speech_warmth"],
                "formality": row["speech_formality"],
                "humor": row["speech_humor"],
                "address_as": row["speech_address_as"],
            },
            "pedagogy": {
                "style": row["pedagogy_style"],
                "patience": row["pedagogy_patience"],
                "on_wrong_answer": row["pedagogy_on_wrong_answer"],
                "analogy_sources": row["pedagogy_analogy_sources"],
                "encouragement": row["pedagogy_encouragement"],
            },
            "few_shot": row["few_shot"],
            "never_does": row["never_does"],
            "voice": voice,
            "avatar": {
                "provider": row["avatar_provider"],
                "avatar_ref": row["avatar_ref"],
            },
            "consent": {
                "status": row["consent_status"],
                "recording_uri": row["consent_recording_uri"],
                "granted_at": _ts_out(row["consent_granted_at"]),
                "revoked_at": _ts_out(row["consent_revoked_at"]),
                "captured_in_session": row["consent_captured_in_session"],
            },
        }
    )


def normalized(spec: PersonaSpec) -> dict[str, Any]:
    """Canonical form for comparison.

    Consent timestamps are `str` in the spec and timestamptz in the DB, so a
    round trip turns "…Z" into "…+00:00". Compare through this or dirty-checking
    reports a phantom diff on every persona that has a consent record.
    """
    d = spec.model_dump(mode="json")
    consent = d.get("consent") or {}
    for key in ("granted_at", "revoked_at"):
        consent[key] = _ts_out(_ts_in(consent.get(key)))
    return d


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------


class PersonaConflictError(ValueError):
    """A persona with this slug already exists for this owner."""


class ConsentViolationError(ValueError):
    """The database rejected the row on a consent constraint.

    Carries the constraint name so the API can say which rule fired rather than
    returning a generic failure.
    """

    def __init__(self, constraint: str, message: str) -> None:
        super().__init__(message)
        self.constraint = constraint


@runtime_checkable
class PersonaStore(Protocol):
    """Where personas live. Same seam as the vendor providers (§13)."""

    def get(self, slug: str, owner_user_id: str | None = None) -> PersonaSpec: ...

    def list(self, owner_user_id: str | None = None) -> list[PersonaSpec]: ...

    def upsert(self, spec: PersonaSpec, owner_user_id: str | None = None) -> None: ...

    def revoke(self, slug: str, owner_user_id: str | None = None) -> None: ...


class YamlPersonaStore:
    """Read-only store over persona/*.yaml. Satisfies the read half.

    Keeps the CLI and the offline test suite working with no database. Writes
    raise, because hand-edited YAML is the source of truth for the curated
    library and a process that rewrites those files would fight the repo.
    """

    def __init__(self, directory: Path | None = None) -> None:
        self.directory = directory

    def get(self, slug: str, owner_user_id: str | None = None) -> PersonaSpec:
        personas = load_persona_dir(self.directory)
        if slug not in personas:
            available = ", ".join(sorted(personas)) or "(none)"
            raise PersonaNotFoundError(f"no persona {slug!r}; available: {available}")
        return personas[slug]

    def list(self, owner_user_id: str | None = None) -> list[PersonaSpec]:
        return list(load_persona_dir(self.directory).values())

    def upsert(self, spec: PersonaSpec, owner_user_id: str | None = None) -> None:
        raise NotImplementedError(
            "YamlPersonaStore is read-only — use PostgresPersonaStore to create personas"
        )

    def revoke(self, slug: str, owner_user_id: str | None = None) -> None:
        raise NotImplementedError("YamlPersonaStore is read-only")


class PostgresPersonaStore:
    """The `personas` table. Requires the `db` extra."""

    def __init__(self, conn: psycopg.Connection) -> None:
        self.conn = conn

    # Two slug namespaces exist (migration 0005): user-owned personas are
    # unique per (owner, slug), library personas unique on slug alone. The
    # conflict target has to match whichever we're writing.
    _OWNED_CONFLICT = "(owner_user_id, slug) WHERE owner_user_id IS NOT NULL AND deleted_at IS NULL"
    _LIBRARY_CONFLICT = "(slug) WHERE owner_user_id IS NULL AND deleted_at IS NULL"

    def _select(self, slug: str, owner_user_id: str | None) -> dict[str, Any] | None:
        from psycopg.rows import dict_row

        owner_clause = "owner_user_id = %(owner)s" if owner_user_id else "owner_user_id IS NULL"
        with self.conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                f"SELECT * FROM personas "
                f"WHERE slug = %(slug)s AND {owner_clause} AND deleted_at IS NULL",
                {"slug": slug, "owner": owner_user_id},
            )
            return cur.fetchone()

    def get(self, slug: str, owner_user_id: str | None = None) -> PersonaSpec:
        row = self._select(slug, owner_user_id)
        if row is None:
            raise PersonaNotFoundError(f"no persona {slug!r}")
        return row_to_spec(row)

    def list(self, owner_user_id: str | None = None) -> list[PersonaSpec]:
        from psycopg.rows import dict_row

        owner_clause = "owner_user_id = %(owner)s" if owner_user_id else "owner_user_id IS NULL"
        with self.conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                f"SELECT * FROM personas WHERE {owner_clause} AND deleted_at IS NULL ORDER BY slug",
                {"owner": owner_user_id},
            )
            return [row_to_spec(row) for row in cur.fetchall()]

    def upsert(self, spec: PersonaSpec, owner_user_id: str | None = None) -> None:
        import psycopg

        row = spec_to_row(spec)
        row["owner_user_id"] = owner_user_id
        cols = list(row)
        placeholders = ", ".join(f"%({c})s" for c in cols)
        updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols if c != "slug")
        conflict = self._OWNED_CONFLICT if owner_user_id else self._LIBRARY_CONFLICT

        try:
            self.conn.execute(
                f"INSERT INTO personas ({', '.join(cols)}) VALUES ({placeholders}) "
                f"ON CONFLICT {conflict} DO UPDATE SET {updates}",
                row,
            )
        except psycopg.errors.CheckViolation as exc:
            # Name the wall that fired instead of returning a generic failure —
            # the constraint names encode which consent rule was violated.
            constraint = exc.diag.constraint_name or "unknown"
            raise ConsentViolationError(
                constraint, f"database rejected persona {spec.id!r}: {constraint}"
            ) from exc

    def revoke(self, slug: str, owner_user_id: str | None = None) -> None:
        """§9: the person cloned can withdraw consent at any time.

        A soft state, not a delete: the row must survive so the §10 sweep can
        find it and delete the voice and avatar vendor-side.
        """
        owner_clause = "owner_user_id = %(owner)s" if owner_user_id else "owner_user_id IS NULL"
        result = self.conn.execute(
            f"UPDATE personas SET consent_status = 'revoked', consent_revoked_at = now() "
            f"WHERE slug = %(slug)s AND {owner_clause} AND deleted_at IS NULL",
            {"slug": slug, "owner": owner_user_id},
        )
        if result.rowcount == 0:
            raise PersonaNotFoundError(f"no persona {slug!r}")

    def soft_delete(self, slug: str, owner_user_id: str | None = None) -> None:
        """Hard DELETE fails once a session references the persona
        (`sessions.persona_id … ON DELETE NO ACTION`), so deletion is a flag."""
        owner_clause = "owner_user_id = %(owner)s" if owner_user_id else "owner_user_id IS NULL"
        self.conn.execute(
            f"UPDATE personas SET deleted_at = now() "
            f"WHERE slug = %(slug)s AND {owner_clause} AND deleted_at IS NULL",
            {"slug": slug, "owner": owner_user_id},
        )
