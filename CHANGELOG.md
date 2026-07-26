# Changelog

All notable changes to Chalk are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/) · versions are `MAJOR.MINOR.PATCH.MICRO`.

## [0.1.3.0] - 2026-07-26

### Fixed
- The whiteboard now draws while the tutor talks, reliably. The board takeover
  (`present_visual`) fires the moment the answer's audio starts instead of
  several seconds into the narration — interrupting the tutor no longer
  strands a blank board, because the visual is already up before you can
  barge in. Step reveals stay word-synced to the narration.
- A tutor whose drawing was rejected by the spec validator now hears about it
  and redraws: validation errors return to the model as tool errors instead
  of a silent success, so an invalid visual gets corrected in the same turn
  rather than leaving the tutor narrating an empty board.
- After an interruption, the tutor's next real answer re-presents or keeps
  building the visual instead of leaving the board stale; quick computations
  now land on the board too.

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
