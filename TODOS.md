# TODOS

## Voice Agent

### Watch tool-call eagerness with thinking disabled

**What:** Monitor `actions`-per-turn and `droppedActions` in the metrics sink (`TUTOR_METRICS_PATH`) now that the worker runs Sonnet 5 with `thinking="disabled"`.

**Why:** API guidance says disabled thinking makes Sonnet 5 less likely to reach for tools, and this product IS its tool calls. The "speak before you draw" + "board follows the conversation" prompt rules are the mitigation, verified live on 2026-07-26 — but one afternoon of verification for a documented regression axis is thin.

**Context:** `apps/agent/src/tutor_agent/adapters/worker.py` (AnthropicLLM construction). If board-free explanation turns creep up, flip back to `thinking="adaptive"` and pay the ~400-900ms.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Cap or strip retrieval context replayed in history

**What:** Retrieval excerpts now persist in history for up to 12 turns (byte-stable cache prefixes require replaying exactly what was sent).

**Why:** Steady-state prompts can carry ~12 turns × 5 chunks of duplicated excerpt text (cache-read-priced but real context pressure), and adversarial content in learner-uploaded materials now rides the prompt all session instead of one turn.

**Context:** `apps/agent/src/tutor_agent/core/session.py` (`user_content` into `_append_history`). Consider size-capping stored context or stripping it at trim boundaries (a trim already breaks the cache prefix, so it's free there).

**Effort:** M
**Priority:** P2
**Depends on:** None

### Offline parity test for AnthropicLLM.prewarm vs stream_turn

**What:** Assert prewarm and stream_turn send byte-identical thinking/output_config/system/tools, and that a ToolCall with `error` set produces an `is_error` tool_result, using a recording fake at `llm._client`.

**Why:** A drift writes a cache entry real turns can never hit — the shared `_request_kwargs` helper enforces this structurally now, but a test would catch someone bypassing it.

**Context:** `apps/agent/src/tutor_agent/providers/anthropic_llm.py`; follow the skip-if-no-extra pattern the other 22 skipped provider tests use.

**Effort:** S
**Priority:** P3
**Depends on:** None

### sttFinalizeMs is null for utterances with no interim transcript

**What:** A FINAL_TRANSCRIPT arriving with no preceding INTERIM (very short utterances) leaves `speech_ended_at` unset, so `sttFinalizeMs` is null and `firstAudioMs` under-reports for that turn.

**Why:** Turns tuned against partially-null telemetry can mislead; also `speech_ended_at` is one shared nonlocal, so a new final can mis-attribute STT time to a turn still queued on the lock.

**Context:** `apps/agent/src/tutor_agent/adapters/worker.py` `_on_speech_event`. Metrics-only, no user-facing latency impact. Options: per-fragment timestamps in `pending_transcripts`, or document the caveat at the sink.

**Effort:** M
**Priority:** P3
**Depends on:** None

### Anchor constant + layering nits from review

**What:** (a) `present_visual` literal is duplicated between `cue.py` and `protocol.py`; (b) the Anthropic `cache_control` block shape lives in both `session.py` (few-shot mark) and `anthropic_llm.py` (`_cache_marked`); (c) interruption marker `[the learner interrupted you here]` is imitable assistant history a model could speak aloud.

**Why:** Rename/format drift fails silently; the marker leak is low-probability but cheap to guard in the prompt.

**Context:** Flagged by the 2026-07-26 pre-landing review (maintainability + red team), deferred as cosmetic/low-risk.

**Effort:** S
**Priority:** P4
**Depends on:** None

## Tutor Roster

### Aayush roster entry lives on feat/add-aayush-tutor

**What:** `apps/agent/personas/aayush.yaml` ships here, but the TS roster halves (`DEFAULT_LIVE_TUTORS`, `BUILTIN_TUTORS` in `api/_lib/tutorLibrary.ts` / `src/tutorApi.ts`) are on the separate `feat/add-aayush-tutor` branch.

**Why:** If that branch drifts (slug/voice/avatar ref) nothing in-repo catches the divergence; until it lands, the YAML guards a tutor no sidebar can reach.

**Context:** Land `feat/add-aayush-tutor` and verify slugs/voice ids match the YAML.

**Effort:** S
**Priority:** P1
**Depends on:** feat/add-aayush-tutor branch

## Completed
