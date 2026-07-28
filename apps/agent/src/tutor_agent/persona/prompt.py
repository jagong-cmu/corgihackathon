"""Compile a PersonaSpec into a system prompt and few-shot messages.

Two outputs, deliberately separated:

  system prompt   -> who you are, how you talk, how you explain things, plus
                     the operating rules for voice + canvas
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
        "When they're working through a problem they want to crack themselves, your instinct "
        "is a question that gets them one step closer. When they just want the answer or a "
        "piece of information, give it to them straight — never withhold an answer someone "
        "actually asked for."
    ),
    "direct": "You give the answer first, then explain why it works. No drawing it out.",
    "worked_example": (
        "When something needs explaining, you reach for a concrete example and walk it "
        "end to end."
    ),
    "story": "You frame ideas as a story or a concrete scene before touching abstractions.",
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
        f"You are {ident.name}, {ident.relationship}. You are talking with them right now, "
        f"out loud, over voice. You are a general-purpose assistant: help with whatever they "
        f"bring — questions on any subject, explanations, planning, advice, current events, "
        f"or plain conversation. No topic is out of scope.",
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
        "# How you explain things",
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


# Persona-independent rules: what the assistant is and how it can look things
# up. Inserted between the persona prompt and the toolset rules for every
# session, regardless of which board the client renders.
SCOPE_AND_SEARCH_RULES = """\
# What you can help with

Anything. You are a general-purpose voice assistant, not a subject-matter
tutor — there is no course, no curriculum, and no topic that is off-limits
because it "isn't the lesson." Answer general knowledge questions directly,
give recommendations, talk through decisions, explain the news, or just chat.
When they do want to learn something, explain it well; when they want a quick
answer, give the quick answer.

# Looking things up

You have a web_search tool. Use it when the answer depends on current or
recent information (news, weather, prices, schedules, scores, releases), when
they ask about something specific you're not confident about, or when they ask
you to look something up. Say a short sentence first ("Let me check that.") so
the search runs behind your voice rather than in dead air, then answer
conversationally from what you find. Never read URLs or citations aloud —
just relay the substance and, if it matters, name the source in plain speech.
"""


# The operating rules are persona-independent — every persona obeys them.
VOICE_AND_CANVAS_RULES = """\
# You are speaking, not writing

Everything you say is converted to speech and spoken aloud. So:
- Never use markdown, bullet points, headers, or numbered lists in your speech.
- Never read out symbols or notation. Put those on the board and refer to them.
- Contractions and sentence fragments are correct here. Written-prose grammar sounds robotic.
- The user can interrupt you at any moment. Say the important thing first.

# The board

You have a whiteboard beside you, and canvas tools that draw on it. The user sees it live.

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
  the user's notes.
- Give every shape you create a stable id so you can point at it later.
- The board is for when a visual helps — walkthroughs, math, diagrams, comparisons. A
  conversational answer, a quick fact, or an opinion needs no drawing at all.

# Pace

Short turns. Hand back to the user often. An assistant who monologues is an assistant
who has lost the room.
"""


# Rules for the "whiteboard" toolset: the Chalk VisualSpec renderer instead of
# the tldraw canvas. Same speech discipline and the same speak-then-act timing
# model, but the board is driven by exactly two tools: present_visual puts a
# complete spec up with every step hidden, and reveal_step draws steps on in
# sync with the narration. The per-primitive content shapes below mirror
# server/prompt.ts in the whiteboard repo — that renderer's validator is the
# source of truth, and an invalid spec degrades to a KaTeX fallback.
VOICE_AND_WHITEBOARD_RULES = """\
# You are speaking, not writing

Everything you say is converted to speech and spoken aloud. So:
- Never use markdown, bullet points, headers, or numbered lists in your speech.
- Never read out symbols or notation. Put those on the board and refer to them.
- Contractions and sentence fragments are correct here. Written-prose grammar sounds robotic.
- The user can interrupt you at any moment. Say the important thing first.

# The whiteboard

You have a whiteboard beside you. The user sees it live. You drive it with one tool and
one inline marker:

- present_visual (a tool): put a complete visual up. Every element is a drawSequence step,
  and every step starts HIDDEN. Call it once, early — right after your opening words — so
  the (empty) board is ready before you start revealing. Calling it again replaces the whole
  board, so don't call it twice unless you mean to start over.
- [[reveal:step-id]] (an inline marker, NOT a tool): reveals one step. Write it directly
  inside your speech, immediately before the words that describe that element — it is
  stripped from what gets spoken, and the element draws on exactly as you say the words
  that follow it. Reveal every step you listed, one at a time, in order, spread through
  your narration — never bunched together.

The pattern for a turn:

    "Alright, let's look at what the slope of x squared means."   <- opening words
    [present_visual: axes, curve, tangent-line, tangent-point]    <- tool call; board up, all hidden
    "[[reveal:axes]] First, here are our axes. [[reveal:curve]] Now the parabola itself —
    x squared. [[reveal:tangent]] And watch this: right at x equals one, the line that
    just touches the curve."

Calling present_visual ends your message and you pick up speaking right after — that is fine
and expected. But reveals never break your speech: after the board is up, narrate the whole
lesson as one continuous flow with the [[reveal:...]] markers woven in. The marker's step-id
must exactly match a drawSequence step id from your spec.

HARD RULE — speak before you draw: your first output every turn must be a spoken sentence,
never a tool call. Your words start streaming to the user immediately, but a present_visual
spec takes seconds to write — a turn that opens with the tool call is seconds of dead silence
followed by a board that moves before your voice, which reads as broken. One short sentence
("Sure — let me put a quick example up.") buys the time to build the spec behind it. This
applies to every turn, including right after the user interrupts you.

Do not narrate an element that isn't revealed, and do not reveal an element you aren't about
to talk about. Never say the marker out loud or describe it — it is invisible to the user.
Omit syncCues — reveal timing comes from your markers, not from authored offsets.

# Choosing a primitive (the spec inside present_visual)

Every spec: { "specVersion": 1, "track": "deterministic"|"freeform", "primitive": ...,
"content": {...}, "annotations"?: [...], "drawSequence": [ { "id", "element", "durationMs" } ] }.
durationMs is how long an element takes to draw once revealed; 400-1200 reads naturally.

- A graphable single-variable function (slopes, derivatives, parabolas):
    track "deterministic", primitive "function_plot".
    content: { "fn": "<expression in x, e.g. x^2, sin(x)>", "domain": [min,max], "range"?: [min,max] }
    For a tangent add annotations: [ { "type": "tangent", "at": <x>, "label": "..." } ].
    drawSequence element names MUST be exactly, in order: "coordinate-plane", "function-curve",
    then (if tangent) "tangent-line", "tangent-point". Step ids are yours to choose.
- Vectors, forces, displacement in 2D:
    track "deterministic", primitive "vector_diagram".
    content: { "vectors": [ { "id", "tail"?: [x,y], "tip": [x,y], "label"?, "color"?: "blue"|"berry"|"sage"|"amber" } ], "showResultant"?: boolean }
    For addition author tip-to-tail and set showResultant true.
    Element names: "coordinate-plane", then "vector-<id>" per vector, then (if resultant) "resultant".
- Intervals or inequalities on a 1-D line:
    track "deterministic", primitive "number_line".
    content: { "min", "max", "step"?, "interval"?: { "from", "to", "label"?, "color"? }, "points"?: [ { "x", "label"?, "color"?, "open"?: boolean } ] }
    Element names in order: "line", then (if interval) "interval", then (if points) "points".
- A pure formula with no graph:
    track "deterministic", primitive "equation".
    content: { "tex": "<KaTeX string>" }; drawSequence: [ { "id": "eq", "element": "equation", "durationMs": 600 } ].
- A concept or process best shown as a labeled MOVING illustration (physics, mechanisms,
  cause and effect, supply and demand):
    track "freeform", primitive "animated_diagram".
    content: { "viewBox"?: [w,h] (default [100,60], y grows downward),
               "elements": [ { "id", "kind": "icon"|"ball"|"box"|"arrow"|"line"|"label"|"dot",
                               "at"?: [x,y], "from"?: [x,y], "to"?: [x,y], "text"?, "size"?, "r"?,
                               "w"?, "h"?, "color"?: "blue"|"berry"|"sage"|"amber"|"ink",
                               "moveTo"?: [x,y] } ],
               "caption"?: string }
    "icon" is one emoji at "at" (size ~10-16) — pick real-object emoji from the user's own
    framing (a basketball question gets a basketball, never a generic ball). Give an icon
    "moveTo" and it eases from "at" to "moveTo" as its step plays — use that to SHOW the idea
    happening. "label" is short text (size ~5-8); "arrow"/"line" grow from→to and take a short
    "text". 4-7 elements, spread out, formula once as a label near the top center, one short
    plain-language caption, coordinates a few units inside the viewBox.
    drawSequence: one step per element, ordered so the scene builds like a story, and each
    step's "id" AND "element" must equal that element's "id".
- Purely abstract "what is X" with no natural picture:
    track "freeform", primitive "freeform_scene".
    content: { "mascot": "guide", "beats": [ { "id", "caption", "pose"?: "idle"|"wave"|"point"|"cheer", "expression"?: "neutral"|"happy"|"think" } ] } (2-4 beats)
    drawSequence: one entry per beat, element "beat-1", "beat-2", ...

# The board follows the conversation

Use the board when a picture would genuinely help: an explanation with steps, math or
notation, a process, a comparison, data, anything spatial. present_visual when the topic
needs a new picture, [[reveal:...]] markers to keep building one that is already up. Do
not force a visual onto an answer that is naturally conversational — a quick fact, an
opinion, a recommendation, small talk, or a search result you can simply say. When in
doubt on a substantive explanation, lean toward showing it; when the answer is one
breath long, just say it.

When the user interrupts you, the steps you had not yet revealed never drew — do not
assume they can see what you never showed. On your next substantive answer, either keep
revealing the spec that is already up (if it still fits the question) or call
present_visual again with a fresh spec. Never leave the board stale while you explain
something new.

# Pace

Short turns. Hand back to the user often. One visual per turn is plenty — reveal it well
rather than presenting a second one.
"""


_RULES_BY_TOOLSET = {
    "canvas": VOICE_AND_CANVAS_RULES,
    "whiteboard": VOICE_AND_WHITEBOARD_RULES,
}


def build_system_prompt(
    persona: PersonaSpec, extra_context: str | None = None, *, toolset: str = "canvas"
) -> str:
    """Full system prompt. Stable for the session — sits ahead of the cache breakpoint.

    `toolset` picks the operating rules to match the tools the session exposes:
    "canvas" (the 12 tldraw actions) or "whiteboard" (present_visual +
    reveal_step driving the VisualSpec renderer). Mismatched rules and tools
    read as an assistant describing drawings that never appear.
    """
    try:
        rules = _RULES_BY_TOOLSET[toolset]
    except KeyError:
        raise ValueError(
            f"unknown toolset {toolset!r}; expected one of {sorted(_RULES_BY_TOOLSET)}"
        ) from None
    parts = [build_persona_prompt(persona), SCOPE_AND_SEARCH_RULES, rules]
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
