"""Compile a PersonaSpec into a system prompt and few-shot messages.

Two outputs, deliberately separated:

  system prompt   -> who you are, how you talk, how you teach, plus the
                     operating rules for voice + canvas
  few-shot turns  -> real exchanges prepended to the conversation

The few-shot turns are what actually transfer mannerism. The system prompt
tells the model *about* a person; the few-shot shows it the shape of their
turns — length, rhythm, where they break off, what they do with a wrong answer.

Both halves are stable for the whole session, so they sit ahead of the prompt
cache breakpoint and are written once per session rather than per turn.
"""

from __future__ import annotations

from .spec import Level, PersonaSpec, Verbosity

_VERBOSITY_RULE = {
    Verbosity.TERSE: (
        "Keep turns to one or two sentences. This is a conversation, not a lecture — "
        "stop talking and let them answer."
    ),
    Verbosity.MEDIUM: "Keep turns to two or three sentences before handing back.",
    Verbosity.EXPANSIVE: (
        "You can run four or five sentences when the idea needs it, but still hand back often."
    ),
}

_WARMTH_RULE = {
    Level.LOW: "Matter-of-fact. You don't do reassurance.",
    Level.MEDIUM: "Friendly, but you don't fuss over them.",
    Level.HIGH: "Genuinely warm. You notice when they're frustrated and say so.",
}

_FORMALITY_RULE = {
    Level.LOW: "Casual. Contractions, sentence fragments, the way people actually talk.",
    Level.MEDIUM: "Conversational but composed.",
    Level.HIGH: "Precise and measured. Full sentences.",
}

_PATIENCE_RULE = {
    Level.LOW: "You move fast and expect them to keep up.",
    Level.MEDIUM: "You'll re-explain once, then try a different angle.",
    Level.HIGH: "You will circle back as many times as it takes without a hint of irritation.",
}

_STYLE_RULE = {
    "socratic": (
        "You teach by asking. When they're stuck, your instinct is a question that gets them "
        "one step closer — not the answer."
    ),
    "direct": "You give the answer first, then explain why it works. No drawing it out.",
    "worked_example": (
        "You demonstrate on a parallel problem end to end, then hand them a similar one to try."
    ),
    "story": "You frame the idea as a story or a concrete scene before touching notation.",
}


def _bullet(items: list[str]) -> str:
    return "\n".join(f"- {item}" for item in items)


def build_persona_prompt(persona: PersonaSpec) -> str:
    """The persona half of the system prompt: who this person is."""
    ident = persona.identity
    speech = persona.speech
    ped = persona.pedagogy

    sections: list[str] = []

    who = [
        f"You are {ident.name}, {ident.relationship}. You are tutoring them right now, "
        f"out loud, over voice.",
    ]
    if ident.bio:
        who.append(ident.bio)
    if persona.kind.value == "synthetic":
        who.append(
            "You are a character, not a real person. If asked, you say so plainly rather "
            "than claiming to be someone's actual relative or friend."
        )
    sections.append("\n".join(who))

    talk = [
        "# How you talk",
        _VERBOSITY_RULE[speech.verbosity],
        _WARMTH_RULE[speech.warmth],
        _FORMALITY_RULE[speech.formality],
    ]
    if speech.humor:
        talk.append(f"Your humor is {speech.humor}.")
    if speech.address_as:
        talk.append(f"You sometimes call them '{speech.address_as}'. Not every turn.")
    if speech.catchphrases:
        talk.append(
            "Phrases you actually use — reach for at most one every few turns, never twice "
            "in a row:\n" + _bullet(speech.catchphrases)
        )
    if speech.fillers:
        talk.append(
            "You start sentences with these small sounds the way people do in speech: "
            + ", ".join(f"'{f}'" for f in speech.fillers)
            + ". Use them lightly — they make you sound like a person rather than a narrator."
        )
    sections.append("\n\n".join(talk))

    teach = [
        "# How you teach",
        _STYLE_RULE.get(ped.style.value, ""),
        _PATIENCE_RULE[ped.patience],
        f"When they get something wrong, your move is: {ped.on_wrong_answer}.",
    ]
    if ped.analogy_sources:
        teach.append(
            "When you reach for an analogy it tends to come from "
            + ", ".join(ped.analogy_sources)
            + "."
        )
    if ped.encouragement:
        teach.append(f"Your praise is {ped.encouragement}.")
    sections.append("\n\n".join(t for t in teach if t))

    if persona.never_does:
        sections.append(
            "# Never\n"
            + _bullet(persona.never_does)
            + "\n\nThese are hard constraints. They are the difference between sounding like "
            f"{ident.name} and sounding like a chatbot."
        )

    return "\n\n".join(sections)


# The operating rules are persona-independent — every tutor obeys them.
VOICE_AND_CANVAS_RULES = """\
# You are speaking, not writing

Everything you say is converted to speech and spoken aloud. So:
- Never use markdown, bullet points, headers, or numbered lists in your speech.
- Never read out symbols or notation. Put those on the board and refer to them.
- Contractions and sentence fragments are correct here. Written-prose grammar sounds robotic.
- The learner can interrupt you at any moment. Say the important thing first.

# The board

You have a whiteboard beside you, and canvas tools that draw on it. The learner sees it live.

Each canvas action is timed to fire on the words you speak AFTER it. So the pattern is
speak, then act, then keep speaking:

    "Okay, so we're factoring this one."     <- you say this
    [equation]                                <- then draw it
    "See those two numbers? They have to multiply to three."
    [highlight]
    "And that's the pair we want."

Two things follow from that:

- Say something before your first action, unless the action genuinely belongs on your very
  first word. An action called before you have spoken fires at the start of the audio, which
  means it lands with no narration attached to it.
- Spread your actions through the turn instead of calling them all at once up front. Calling
  three tools in a row and then talking makes all three fire simultaneously on your opening
  syllable.

You will not be able to continue the same sentence after calling a tool — calling a tool ends
your message, and you pick up speaking again right after. That is fine and expected. Plan your
turn as alternating beats of speech and action.

Other board rules:
- Write things down as you say them. Do not narrate a derivation that isn't on the board.
- Placement is relative to the current section, never absolute across the whole board.
- Prefer new_section over erasing. The board scrolls like a real lecture and doubles as
  the learner's notes.
- Give every shape you create a stable id so you can point at it later.

# Pace

Short turns. Hand back to the learner often. A tutor who monologues is a tutor who has
lost the room.
"""


def build_system_prompt(persona: PersonaSpec, extra_context: str | None = None) -> str:
    """Full system prompt. Stable for the session — sits ahead of the cache breakpoint."""
    parts = [build_persona_prompt(persona), VOICE_AND_CANVAS_RULES]
    if extra_context:
        parts.append(extra_context)
    return "\n\n".join(parts)


def build_few_shot_messages(persona: PersonaSpec) -> list[dict[str, str]]:
    """Few-shot exchanges as alternating turns, prepended to the real conversation.

    Returned as plain dicts in Anthropic message shape so this module stays
    independent of the SDK (and of whether we're on the realtime or messaging
    channel).
    """
    messages: list[dict[str, str]] = []
    for exchange in persona.few_shot:
        messages.append({"role": "user", "content": exchange.student})
        messages.append({"role": "assistant", "content": exchange.tutor})
    return messages


def estimate_prompt_overhead(persona: PersonaSpec) -> int:
    """Rough character count of the persona's fixed prompt cost.

    Not a token count — use the real count_tokens endpoint for that. This exists
    so persona authoring tools can warn when a spec is getting bloated, since
    every character here is re-read (from cache) on every single turn.
    """
    system = build_system_prompt(persona)
    few_shot = sum(len(m["content"]) for m in build_few_shot_messages(persona))
    return len(system) + few_shot
