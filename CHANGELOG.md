# Changelog

All notable changes to Chalk are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/) · versions are `MAJOR.MINOR.PATCH.MICRO`.

## [0.1.7.0] - 2026-07-26

### Fixed
- Newly created tutors get their talking avatar again. A full-resolution phone
  photo blew past the avatar vendor's 4.5MB upload cap (the plugin re-encodes
  photos as PNG, turning a 1.6MB shot into a 7MB payload), so the handshake
  failed and the session silently fell back to a static picture. Photos are
  now downscaled to fit before upload.
- Phone photos no longer produce a sideways avatar: EXIF rotation is baked
  into the pixels before the upload strips it.

## [0.1.5.0] - 2026-07-26

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
## [0.1.4.0] - 2026-07-26

### Changed
- Tutor lessons flow in real time. Step reveals now ride inside the tutor's
  narration as inline markers instead of tool calls, so a five-step lesson no
  longer pauses for a model round trip between every beat — the tutor speaks
  one continuous stream and the board draws along with it.
- The whiteboard appears the instant the tutor starts answering: the board
  mount is sent the moment the visual is authored instead of after the first
  sentence finishes synthesizing.

### Fixed
- A lesson can no longer end with a mounted-but-blank board: any step the
  tutor listed but never revealed draws at the end of the answer.

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
