"""Channel-agnostic tutor brain.

Layering, outermost to innermost:

    adapters/   realtime (LiveKit) and later messaging (Photon). NO tutoring
                logic lives here — adapters move bytes, nothing else.
    core/       TutorSession, cue timing, action validation. All the
                intelligence. Knows nothing about WebRTC or SMS.
    providers/  Vendor adapters behind Protocols, plus offline fakes.
    persona/    Who the tutor is: identity, speech habits, pedagogy, few-shot.
"""

__version__ = "0.1.0"
