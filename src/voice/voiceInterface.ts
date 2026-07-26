/**
 * ============================================================================
 *  Voice module interface (OUT OF SCOPE to implement — we mock it).
 * ============================================================================
 *
 * The voice teammate owns STT + a cloned TTS voice. The ONLY contract between
 * their module and ours is:
 *   - they receive `spokenText` (a sibling of the VisualSpec on each turn),
 *   - as the narration plays, they call `revealStep(stepId)` to drive the
 *     whiteboard reveal in sync with the spoken words.
 *
 * GUARDRAIL: never block speech on a visual. `spokenText` is emitted
 * immediately; visuals reveal asynchronously via these cues.
 *
 * For now we provide a MOCK driver that fires cues on a timer (using each
 * cue's `atMs`). Swapping in the real voice = calling `revealStep` from their
 * TTS word-boundary events instead of from our timer.
 */
import type { SyncCue } from "../spec/visualSpec";

export interface VoiceDriver {
  /** Begin narration + start firing reveal cues. */
  start: () => void;
  /** Stop and clear any pending cues. */
  stop: () => void;
}

export interface RevealApi {
  /** Reveal a single draw step by id. Idempotent. */
  revealStep: (stepId: string) => void;
}

/**
 * Mock voice: fires `revealStep(cue.stepId)` at each cue's `atMs`. This stands
 * in for the real cloned voice hitting phrase boundaries.
 */
export function createMockVoiceDriver(
  cues: SyncCue[],
  api: RevealApi
): VoiceDriver {
  let timers: ReturnType<typeof setTimeout>[] = [];

  return {
    start() {
      // Defensive: clear any prior run first.
      timers.forEach(clearTimeout);
      timers = cues.map((cue) =>
        setTimeout(() => api.revealStep(cue.stepId), cue.atMs ?? 0)
      );
    },
    stop() {
      timers.forEach(clearTimeout);
      timers = [];
    },
  };
}
