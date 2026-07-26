"""Load and validate persona YAML files."""

from __future__ import annotations

from pathlib import Path

import yaml

from .spec import PersonaSpec

DEFAULT_PERSONA_DIR = Path(__file__).resolve().parents[3] / "personas"


class PersonaNotFoundError(LookupError):
    pass


def load_persona_file(path: Path) -> PersonaSpec:
    """Load one persona. Raises pydantic.ValidationError on a malformed spec.

    Validation is strict on purpose: a persona with a typo'd field silently
    falling back to a default would ship a tutor that sounds subtly wrong, and
    that failure is very hard to trace back to a YAML key.
    """
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"{path}: expected a YAML mapping at the top level")
    return PersonaSpec.model_validate(raw)


def load_persona_dir(directory: Path | None = None) -> dict[str, PersonaSpec]:
    """Load every persona in a directory, keyed by id.

    Files ending in `.template.yaml` are skipped — they're authoring scaffolds
    with placeholder ids, not loadable personas.
    """
    directory = directory or DEFAULT_PERSONA_DIR
    personas: dict[str, PersonaSpec] = {}
    if not directory.is_dir():
        return personas

    for path in sorted(directory.glob("*.yaml")):
        if path.name.endswith(".template.yaml"):
            continue
        persona = load_persona_file(path)
        if persona.id in personas:
            raise ValueError(f"duplicate persona id {persona.id!r} in {path}")
        personas[persona.id] = persona
    return personas


def get_persona(persona_id: str, directory: Path | None = None) -> PersonaSpec:
    personas = load_persona_dir(directory)
    if persona_id not in personas:
        available = ", ".join(sorted(personas)) or "(none)"
        raise PersonaNotFoundError(f"no persona {persona_id!r}; available: {available}")

    persona = personas[persona_id]
    if persona.is_revoked:
        # §9: personas are revocable by the person cloned, at any time.
        raise PersonaNotFoundError(
            f"persona {persona_id!r} was revoked at {persona.consent.revoked_at} "
            "and can no longer be used"
        )
    return persona
