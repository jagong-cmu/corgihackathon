"""The persona spec: identity + face + voice + explaining style (README §9).

A persona is NOT a paragraph of prose. Prose produces a generic assistant
wearing someone's voice. What actually carries mannerism is:

  1. structured speech habits  -> compiled into explicit prompt constraints
  2. few-shot dialogue         -> the model imitates the shape of real turns
  3. an explicit never-do list -> suppresses default assistant tics

(2) does most of the work. Three or four real exchanges beat any amount of
adjective-stacking in a description field.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, model_validator


class PersonaKind(StrEnum):
    """§9. Determines which consent machinery applies."""

    SYNTHETIC = "synthetic"
    """A designed character with a licensed/stock voice. No consent needed."""

    SELF = "self"
    """The account owner cloned themselves. They are the data subject, so no
    third-party consent flow is required — but deletion still cascades to the
    vendor-side voice and avatar."""

    REAL_PERSON = "real_person"
    """Someone else, cloned with recorded consent. Requires a completed consent
    session and is revocable by that person at any time."""


class Verbosity(StrEnum):
    TERSE = "terse"
    MEDIUM = "medium"
    EXPANSIVE = "expansive"


class Level(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class TeachingStyle(StrEnum):
    SOCRATIC = "socratic"
    """Guides with questions when the user wants to work something out themselves;
    still answers directly when they just want the answer."""
    DIRECT = "direct"
    """States the answer, then explains why."""
    WORKED_EXAMPLE = "worked_example"
    """Explains by walking a concrete example end to end."""
    STORY = "story"
    """Frames concepts as narrative before formalizing."""


class Identity(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    relationship: str = Field(
        description="How the user knows this person, e.g. 'the user's personal assistant'. "
        "Goes into the prompt verbatim, so write it in third person."
    )
    bio: str | None = Field(
        default=None,
        description="One or two sentences of background the assistant may reference naturally.",
    )


class Speech(BaseModel):
    """How the person talks, independent of what they're explaining."""

    model_config = ConfigDict(extra="forbid")

    catchphrases: list[str] = Field(
        default_factory=list,
        max_length=8,
        description="Phrases this person actually says. Used sparingly — the prompt "
        "instructs at most one per few turns so they don't become a verbal tic.",
    )
    fillers: list[str] = Field(
        default_factory=list,
        max_length=6,
        description="Short disfluencies like 'mm', 'right', 'so'. These are a large "
        "part of why cloned speech sounds like a person instead of a narrator.",
    )
    verbosity: Verbosity = Verbosity.MEDIUM
    warmth: Level = Level.MEDIUM
    formality: Level = Level.LOW
    humor: str | None = Field(
        default=None, description="e.g. 'dry', 'goofy', 'none'. Free text; goes in the prompt."
    )
    address_as: str | None = Field(
        default=None,
        description="What this person calls the learner, e.g. 'kiddo'. Omit for none.",
    )


class Pedagogy(BaseModel):
    """How the person explains things."""

    model_config = ConfigDict(extra="forbid")

    style: TeachingStyle = TeachingStyle.DIRECT
    patience: Level = Level.HIGH
    on_wrong_answer: str = Field(
        default="asks what led them there before correcting",
        description="The single highest-signal pedagogy field. Wrong answers are where "
        "a person's character actually shows.",
    )
    analogy_sources: list[str] = Field(
        default_factory=list,
        max_length=8,
        description="Domains this person reaches into for analogies, e.g. ['cooking']. "
        "Distinct from the user's interests, which drive simulation theming.",
    )
    encouragement: str | None = Field(
        default=None, description="How they praise, e.g. 'understated — a nod, not a parade'."
    )


class Exchange(BaseModel):
    """One user turn and the assistant's reply, in this persona's voice.

    Field names stay `student`/`tutor` for wire and YAML compatibility."""

    model_config = ConfigDict(extra="forbid")

    student: str
    tutor: str
    note: str | None = Field(
        default=None,
        description="Author's note about why this reply is characteristic. Not sent to the model.",
    )


class VoiceConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str = "elevenlabs"
    voice_id: str = Field(description="Provider-side voice id. For clones, created at enrollment.")
    model: str = Field(
        default="eleven_flash_v2_5",
        description="Flash v2.5 in the realtime loop (~75ms). v3 is NOT realtime — "
        "pre-rendered library content only (§3).",
    )
    stability: float = Field(default=0.5, ge=0.0, le=1.0)
    similarity_boost: float = Field(default=0.75, ge=0.0, le=1.0)


class AvatarConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str = Field(
        default="lemonslice",
        description="lemonslice | simli | tavus | none. Selected per persona, never hard-coded.",
    )
    avatar_ref: str | None = Field(
        default=None, description="Provider-side avatar id or the source photo's blob key."
    )


class Consent(BaseModel):
    """§9 / §10. Present and complete for real_person, optional for self."""

    model_config = ConfigDict(extra="forbid")

    status: str = Field(
        default="not_required",
        description="not_required | pending | granted | revoked",
    )
    recording_uri: str | None = Field(
        default=None, description="Blob key of the consent statement. Retained as a record."
    )
    granted_at: str | None = None
    revoked_at: str | None = None
    captured_in_session: bool = Field(
        default=False,
        description="True only when voice and photo were captured inside the consent session. "
        "Uploads of third-party media are rejected by design (§9).",
    )


class PersonaSpec(BaseModel):
    """A complete assistant persona."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-z][a-z0-9_-]{1,47}$")
    kind: PersonaKind
    identity: Identity
    speech: Speech = Field(default_factory=Speech)
    pedagogy: Pedagogy = Field(default_factory=Pedagogy)
    few_shot: list[Exchange] = Field(
        default_factory=list,
        max_length=12,
        description="3-8 is the sweet spot. Below 3 the model falls back to a generic "
        "assistant voice; above ~8 you burn prompt cache budget for diminishing returns.",
    )
    never_does: list[str] = Field(
        default_factory=list,
        max_length=10,
        description="Explicit suppressions. Most useful for killing default assistant "
        "tics like 'Great question!' that no real person says.",
    )
    voice: VoiceConfig | None = None
    avatar: AvatarConfig = Field(default_factory=AvatarConfig)
    consent: Consent = Field(default_factory=Consent)

    @model_validator(mode="after")
    def _enforce_consent_rules(self) -> PersonaSpec:
        """§9/§10: likeness consent is mandatory and non-negotiable.

        Enforced in the type system rather than at the UI layer, so no code path
        can construct a real-person persona without a granted consent record
        whose media was captured in-session.

        Note what is deliberately NOT checked here: revocation. A revoked
        persona must remain *representable*, because §9 makes personas revocable
        at any time and §10 requires a sweep that finds revoked personas to
        delete their voices and avatars vendor-side. A validator that refused to
        construct them would make the revoked state unreachable for exactly the
        personas revocation exists for.

        Representable is not the same as usable: `get_persona()` refuses to
        serve a revoked persona, which is the correct layer for that check.
        """
        if self.kind is PersonaKind.REAL_PERSON:
            if self.consent.status != "granted":
                raise ValueError(
                    f"persona '{self.id}': kind=real_person requires consent.status='granted' "
                    f"(got {self.consent.status!r}). See README §9."
                )
            if not self.consent.captured_in_session:
                raise ValueError(
                    f"persona '{self.id}': real-person voice and photo must be captured inside "
                    "the consent session; uploaded third-party media is rejected by design."
                )
        return self

    @property
    def is_revoked(self) -> bool:
        """True once the person cloned has withdrawn consent.

        Such a persona still loads (so deletion sweeps can find it) but
        `get_persona()` will not serve it into a session.
        """
        return self.consent.revoked_at is not None
