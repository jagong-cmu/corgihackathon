"""Persona store: the mapper and the YAML implementation.

The Postgres implementation is exercised by `make seed` in infra/, which runs
against a real database and probes the constraints. These tests cover the parts
that must work with no database at all.
"""

from __future__ import annotations

import pytest

from tutor_agent.persona import PersonaNotFoundError, PersonaSpec
from tutor_agent.persona.loader import DEFAULT_PERSONA_DIR
from tutor_agent.persona.store import (
    PersonaStore,
    PostgresPersonaStore,
    YamlPersonaStore,
    normalized,
    row_to_spec,
    spec_to_row,
)


def _ada() -> PersonaSpec:
    return YamlPersonaStore(DEFAULT_PERSONA_DIR).get("ada")


class TestMapper:
    """spec_to_row / row_to_spec were promoted out of infra/scripts/seed.py so
    there is exactly one definition of the mapping."""

    def test_round_trip_preserves_everything(self):
        spec = _ada()
        row = spec_to_row(spec)
        # spec_to_row wraps few_shot in psycopg's Jsonb; the DB hands back the
        # plain list, so unwrap to simulate a read.
        row["few_shot"] = row["few_shot"].obj
        assert normalized(row_to_spec(row)) == normalized(spec)

    def test_nested_structures_are_flattened(self):
        row = spec_to_row(_ada())
        assert row["identity_name"] == "Ada"
        assert "okay, so" in row["speech_catchphrases"]
        assert row["pedagogy_style"] == "socratic"
        assert row["never_does"]

    def test_voice_is_all_or_nothing(self):
        """personas_voice_grouped requires 0 or 5 non-null voice columns."""
        spec = _ada().model_copy(update={"voice": None})
        row = spec_to_row(spec)
        voice_cols = [
            row["voice_provider"],
            row["voice_id"],
            row["voice_model"],
            row["voice_stability"],
            row["voice_similarity_boost"],
        ]
        assert all(v is None for v in voice_cols)

    def test_owner_and_id_are_not_emitted(self):
        """Ownership is the caller's to supply — the same spec can be a library
        persona or a user's own."""
        row = spec_to_row(_ada())
        assert "owner_user_id" not in row
        assert "id" not in row

    def test_normalized_absorbs_the_timestamp_round_trip(self):
        """Consent times are str in the spec and timestamptz in the DB, so a
        round trip turns '…Z' into '…+00:00'. Without normalizing, every
        persona with a consent record shows a phantom diff."""
        spec = PersonaSpec.model_validate(
            {
                "id": "tz-probe",
                "kind": "self",
                "identity": {"name": "T", "relationship": "self"},
                "consent": {"status": "granted", "granted_at": "2026-07-01T00:00:00Z"},
            }
        )
        assert normalized(spec)["consent"]["granted_at"] == "2026-07-01T00:00:00+00:00"


class TestYamlStore:
    def test_satisfies_the_protocol(self):
        assert isinstance(YamlPersonaStore(), PersonaStore)

    def test_reads_the_bundled_library(self):
        slugs = {p.id for p in YamlPersonaStore(DEFAULT_PERSONA_DIR).list()}
        assert {"ada", "coach-rios"} <= slugs

    def test_missing_persona_names_the_alternatives(self):
        with pytest.raises(PersonaNotFoundError, match="ada"):
            YamlPersonaStore(DEFAULT_PERSONA_DIR).get("nope")

    def test_writes_are_refused_rather_than_silently_dropped(self):
        """The curated library is hand-edited YAML; a process that rewrote
        those files would fight the repo."""
        store = YamlPersonaStore(DEFAULT_PERSONA_DIR)
        with pytest.raises(NotImplementedError, match="read-only"):
            store.upsert(_ada())
        with pytest.raises(NotImplementedError):
            store.revoke("ada")


class TestPostgresStoreShape:
    """Structural checks that need no database."""

    def test_satisfies_the_protocol(self):
        assert isinstance(PostgresPersonaStore(conn=None), PersonaStore)

    def test_conflict_targets_match_the_0011_indexes(self):
        """Migration 0011 added `deleted_at IS NULL` to both partial unique
        indexes. A conflict target that omits it matches no index and fails at
        runtime with InvalidColumnReference — which is exactly what broke the
        seed script when 0011 landed."""
        for target in (
            PostgresPersonaStore._OWNED_CONFLICT,
            PostgresPersonaStore._LIBRARY_CONFLICT,
        ):
            assert "deleted_at IS NULL" in target
        assert "owner_user_id IS NOT NULL" in PostgresPersonaStore._OWNED_CONFLICT
        assert "owner_user_id IS NULL" in PostgresPersonaStore._LIBRARY_CONFLICT
