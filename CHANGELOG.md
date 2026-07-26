# Changelog

All notable changes to Chalk are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/) · versions are `MAJOR.MINOR.PATCH.MICRO`.

## [0.1.2.0] - 2026-07-26

### Changed
- Tutors answer fast enough to hold a real conversation. The pause between
  finishing a question and hearing the reply dropped from 3-4.5 seconds to
  roughly 1.6-2.4 seconds, and the first question of a session is no longer
  the slowest — the tutor warms up its connections and prompt cache while you
  join. Long whiteboard lessons also stopped stalling between drawing steps.
- Tutors always say something before they start drawing. A follow-up like
  "show me an example" used to mean several seconds of silence while the
  board was prepared; now the tutor talks first and builds the board behind
  the words.
- The board mounts the moment the tutor decides to draw, instead of waiting
  for the next sentence to finish synthesizing.

### Fixed
- Interrupting the tutor no longer wipes its memory of the exchange: it keeps
  what it actually said (and only what you actually heard), so follow-ups
  land in context instead of restarting the topic.
- A question that lands as two speech fragments (a breath, a split
  "Hey Nico. / Can you explain X?") is answered once, as one question — even
  while the tutor is busy winding down the reply you interrupted.
- Interrupting the tutor stops its answer-in-progress at the model too, so
  the dead reply no longer burns rate limit that slows down the answer to
  your new question.
- A tutor drawn mid-turn onto a replaced board no longer fires its reveals
  against the wrong picture in session replays.
- Rejected whiteboard specs now come back with a test proving the tutor is
  told the board never mounted (so it fixes the spec instead of narrating an
  invisible drawing).
- Per-turn latency telemetry now measures every leg it claims to: silence
  detection, model first-token, retrieval, and time-to-first-audio at the
  first audible chunk — and stale timing from a discarded utterance can't
  poison the next turn's numbers.

### Added
- Aayush joins the tutor library's offline fallback roster.

## [0.1.1.0] - 2026-07-26

### Changed
- Tutors are picked from the sidebar only. The tutor card's dropdown picker is
  gone — the card shows the active tutor with a single "Start session" button.
- "Manage voice tutors" now lives in the sidebar, right under "Create a new
  tutor", so every tutor action starts from one place.
- Seating a whiteboard-only tutor (like Trudy) shows a quiet hint pointing to
  the sidebar instead of an unexplained disabled button.

### Fixed
- Nico shows up in the tutor list on deployed hosts: the production server now
  answers `/api/live/tutors` (it previously 404'd, so deployed clients fell
  back to a roster without him), and Nico joined the offline fallback list.
- Coach Rios's avatar provider matches the worker's persona file (lemonslice).
- Tutor entries supplied via the `TUTOR_LIBRARY` env var are validated and
  normalized before serving: missing fields get safe defaults (a tutor without
  a declared voice can't be rung) and unexpected fields are never exposed.

### Added
- Tutor roster guardrails (`npm run test:tutors`): 24 checks keeping the
  client fallback list, the served library, and the production route in
  lockstep — including a live boot of the production server.
