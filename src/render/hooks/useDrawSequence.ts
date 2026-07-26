/**
 * useDrawSequence — orchestrates the animated reveal.
 *
 * It exposes:
 *   - `revealed`: the set of step ids that have been revealed so far,
 *   - `progress[stepId]`: 0..1 draw-on progress for the *currently drawing* step,
 *   - `revealStep(stepId)`: the method the voice module (real or mocked) calls.
 *
 * When a step is revealed, we animate its progress 0 -> 1 over the step's
 * `durationMs` using requestAnimationFrame. This is the render-layer "draw-on"
 * effect — decoupled entirely from how the spec was generated.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DrawStep } from "../../spec/visualSpec";

export interface DrawSequenceState {
  revealed: Set<string>;
  progress: Record<string, number>;
  revealStep: (stepId: string) => void;
  reset: () => void;
  isRevealed: (stepId: string) => boolean;
}

export function useDrawSequence(steps: DrawStep[]): DrawSequenceState {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<Record<string, number>>({});
  const rafRef = useRef<Map<string, number>>(new Map());

  const durationById = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of steps) m[s.id] = s.durationMs;
    return m;
  }, [steps]);

  const revealStep = useCallback(
    (stepId: string) => {
      setRevealed((prev) => {
        if (prev.has(stepId)) return prev; // idempotent
        const next = new Set(prev);
        next.add(stepId);
        return next;
      });

      const duration = durationById[stepId] ?? 0;
      if (duration <= 0) {
        setProgress((p) => ({ ...p, [stepId]: 1 }));
        return;
      }

      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        setProgress((p) => ({ ...p, [stepId]: t }));
        if (t < 1) {
          rafRef.current.set(stepId, requestAnimationFrame(tick));
        } else {
          rafRef.current.delete(stepId);
        }
      };
      rafRef.current.set(stepId, requestAnimationFrame(tick));
    },
    [durationById]
  );

  const reset = useCallback(() => {
    rafRef.current.forEach((id) => cancelAnimationFrame(id));
    rafRef.current.clear();
    setRevealed(new Set());
    setProgress({});
  }, []);

  const isRevealed = useCallback(
    (stepId: string) => revealed.has(stepId),
    [revealed]
  );

  // Cancel any in-flight animation frames on unmount.
  useEffect(() => {
    const frames = rafRef.current;
    return () => {
      frames.forEach((id) => cancelAnimationFrame(id));
      frames.clear();
    };
  }, []);

  return { revealed, progress, revealStep, reset, isRevealed };
}
