/**
 * The board store — a React-subscribable wrapper around the reducer.
 *
 * The action stream arrives on the data channel and fires from a
 * requestAnimationFrame loop, neither of which is a React event. Rather than
 * pushing that into component state and fighting stale closures, the board
 * lives here and components read it through `useSyncExternalStore`.
 *
 * `applyAction` returns the same object for a no-op, so a cancelled turn's
 * leftover highlights or a sim_control for a shape that never arrived cost one
 * reference comparison and no re-render.
 */

import {
  applyAction,
  emptyBoard,
  tickBoard,
  type BoardState,
} from "./state";
import type { CanvasAction } from "@tutor/canvas-protocol";

export class BoardStore {
  private state: BoardState = emptyBoard();
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): BoardState => this.state;

  apply(action: CanvasAction, nowMs: number): void {
    this.commit(applyAction(this.state, action, { nowMs }));
  }

  /** Pointer expiry and the paced step reveal. Called from the same rAF loop. */
  tick(nowMs: number): void {
    this.commit(tickBoard(this.state, nowMs));
  }

  /**
   * Learner-driven parameter change on a graph. Not a canvas action — it comes
   * from a slider, and the agent hears about it as a `student_event`.
   */
  setParameter(shapeId: string, name: string, value: number): void {
    const sections = this.state.sections.map((section) => ({
      ...section,
      shapes: section.shapes.map((shape) =>
        shape.id === shapeId && shape.kind === "graph"
          ? { ...shape, parameters: { ...shape.parameters, [name]: value } }
          : shape,
      ),
    }));
    this.commit({ ...this.state, sections });
  }

  reset(): void {
    this.commit(emptyBoard());
  }

  private commit(next: BoardState): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
