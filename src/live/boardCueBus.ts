/**
 * boardCueBus — a one-channel event bus between the live voice session and
 * the whiteboard.
 *
 * The session owner (LiveTutorProvider → useLiveTutor, App-level so it
 * survives shell churn) and the board (TutorShell → WhiteboardRenderer) are
 * deliberately decoupled, so cue delivery goes through this module-scope bus
 * instead of prop threading. The provider publishes each cue at its
 * narration-synced moment; whoever renders the board subscribes. No
 * subscriber mounted means the cue drops silently, which is the protocol's
 * guardrail semantics anyway (§13: a missing arrow is invisible, a crashed
 * board ends the lesson).
 */
import type { BoardCue } from "./cueBridge";

type BoardCueListener = (cue: BoardCue) => void;

const listeners = new Set<BoardCueListener>();

export function publishBoardCue(cue: BoardCue): void {
  for (const listener of listeners) listener(cue);
}

/** Subscribe to cue-timed board actions. Returns the unsubscribe function. */
export function subscribeBoardCues(listener: BoardCueListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
