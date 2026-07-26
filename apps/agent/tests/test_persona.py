"""Persona spec, consent enforcement, and prompt compilation."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from tutor_agent.persona import (
    Exchange,
    Identity,
    PersonaKind,
    PersonaSpec,
    Speech,
    Verbosity,
    build_few_shot_messages,
    build_system_prompt,
    load_persona_dir,
)
from tutor_agent.persona.loader import DEFAULT_PERSONA_DIR


def _minimal(**overrides) -> dict:
    base = {
        "id": "test-persona",
        "kind": "synthetic",
        "identity": {"name": "Test", "relationship": "a tutor"},
    }
    base.update(overrides)
    return base


class TestConsentEnforcement:
    """§9/§10 enforced in the type system, not at the UI layer."""

    def test_real_person_without_consent_is_rejected(self):
        with pytest.raises(ValidationError, match="requires consent.status='granted'"):
            PersonaSpec.model_validate(_minimal(kind="real_person"))

    def test_real_person_with_uploaded_media_is_rejected(self):
        with pytest.raises(ValidationError, match="captured inside the consent session"):
            PersonaSpec.model_validate(
                _minimal(
                    kind="real_person",
                    consent={"status": "granted", "captured_in_session": False},
                )
            )

    def test_real_person_with_full_consent_is_accepted(self):
        persona = PersonaSpec.model_validate(
            _minimal(
                kind="real_person",
                consent={
                    "status": "granted",
                    "captured_in_session": True,
                    "recording_uri": "s3://consent/abc",
                },
            )
        )
        assert persona.kind is PersonaKind.REAL_PERSON

    def test_revoked_persona_stays_representable(self):
        """§9/§10. A revoked persona must still LOAD, or the vendor-side
        deletion sweep can never find it — the revoked state would be
        unreachable for exactly the personas revocation exists for.

        Representable is not usable; get_persona() is what refuses to serve it.
        """
        persona = PersonaSpec.model_validate(
            _minimal(
                kind="real_person",
                consent={
                    "status": "granted",
                    "captured_in_session": True,
                    "granted_at": "2026-06-01T00:00:00Z",
                    "revoked_at": "2026-07-01T00:00:00Z",
                },
            )
        )
        assert persona.is_revoked

    def test_revoked_persona_is_not_served(self, tmp_path):
        """The enforcement that actually matters, at the layer that matters."""
        import yaml

        from tutor_agent.persona import PersonaNotFoundError, get_persona

        spec = _minimal(
            id="revoked-one",
            kind="real_person",
            consent={
                "status": "granted",
                "captured_in_session": True,
                "revoked_at": "2026-07-01T00:00:00Z",
            },
        )
        (tmp_path / "revoked-one.yaml").write_text(yaml.safe_dump(spec))

        with pytest.raises(PersonaNotFoundError, match="revoked"):
            get_persona("revoked-one", tmp_path)

    def test_self_clone_needs_no_consent_record(self):
        persona = PersonaSpec.model_validate(_minimal(kind="self"))
        assert persona.kind is PersonaKind.SELF
        assert persona.consent.status == "not_required"

    def test_is_revoked_flag(self):
        persona = PersonaSpec.model_validate(_minimal(kind="synthetic"))
        assert not persona.is_revoked
        persona = PersonaSpec.model_validate(
            _minimal(kind="synthetic", consent={"revoked_at": "2026-07-01T00:00:00Z"})
        )
        assert persona.is_revoked


class TestStrictness:
    def test_unknown_field_is_rejected(self):
        """A typo'd key must fail loudly, not silently fall back to a default."""
        with pytest.raises(ValidationError):
            PersonaSpec.model_validate(_minimal(speech={"verbosty": "terse"}))

    def test_bad_id_is_rejected(self):
        with pytest.raises(ValidationError):
            PersonaSpec.model_validate(_minimal(id="Has Spaces"))


class TestPromptCompilation:
    def _persona(self) -> PersonaSpec:
        return PersonaSpec(
            id="mom",
            kind=PersonaKind.SYNTHETIC,
            identity=Identity(name="Mom", relationship="the learner's mother"),
            speech=Speech(
                catchphrases=["okay so here's the thing"],
                fillers=["mm"],
                verbosity=Verbosity.TERSE,
            ),
            few_shot=[
                Exchange(student="I don't get it.", tutor="Mm. What part?"),
                Exchange(student="The signs.", tutor="Okay so here's the thing — flip one."),
            ],
            never_does=["says 'Great question!'"],
        )

    def test_system_prompt_carries_identity_speech_and_constraints(self):
        prompt = build_system_prompt(self._persona())
        assert "Mom" in prompt
        assert "the learner's mother" in prompt
        assert "okay so here's the thing" in prompt
        assert "mm" in prompt
        assert "Great question" in prompt

    def test_system_prompt_carries_the_operating_rules(self):
        prompt = build_system_prompt(self._persona())
        # Voice channel: no markdown.
        assert "markdown" in prompt.lower()

    def test_prompt_teaches_the_multi_round_action_pattern(self):
        """A message ends at its tool calls; text can't resume after one.

        The model has to spread actions across rounds instead of front-loading
        them, or every cue lands on the opening syllable. Verified live.
        """
        prompt = build_system_prompt(self._persona())
        assert "AFTER it" in prompt
        assert "calling a tool ends" in prompt
        assert "all at once up front" in prompt

    def test_terse_persona_gets_a_terse_instruction(self):
        prompt = build_system_prompt(self._persona())
        assert "one or two sentences" in prompt

    def test_few_shot_alternates_user_and_assistant(self):
        messages = build_few_shot_messages(self._persona())
        assert [m["role"] for m in messages] == ["user", "assistant", "user", "assistant"]
        assert messages[0]["content"] == "I don't get it."
        assert messages[1]["content"] == "Mm. What part?"

    def test_authoring_notes_are_not_sent_to_the_model(self):
        persona = self._persona()
        persona.few_shot[0].note = "SECRET AUTHORING NOTE"
        rendered = " ".join(m["content"] for m in build_few_shot_messages(persona))
        assert "SECRET" not in rendered

    def test_synthetic_persona_is_told_to_admit_it(self):
        prompt = build_system_prompt(self._persona())
        assert "not a real person" in prompt


class TestShippedPersonas:
    def test_bundled_personas_load(self):
        personas = load_persona_dir(DEFAULT_PERSONA_DIR)
        assert "ada" in personas
        assert "coach-rios" in personas

    def test_template_is_skipped(self):
        """self-clone.template.yaml has a CHANGEME id and must not load."""
        personas = load_persona_dir(DEFAULT_PERSONA_DIR)
        assert "CHANGEME" not in personas

    @pytest.mark.parametrize("persona_id", ["ada", "coach-rios"])
    def test_bundled_personas_have_enough_few_shot(self, persona_id: str):
        """Below 3 exchanges the model drifts to a generic tutor voice."""
        persona = load_persona_dir(DEFAULT_PERSONA_DIR)[persona_id]
        assert len(persona.few_shot) >= 3, "personas need 3+ few-shot exchanges to hold character"

    @pytest.mark.parametrize("persona_id", ["ada", "coach-rios"])
    def test_bundled_personas_suppress_assistant_tics(self, persona_id: str):
        persona = load_persona_dir(DEFAULT_PERSONA_DIR)[persona_id]
        assert persona.never_does, "every persona should suppress at least one default tic"
