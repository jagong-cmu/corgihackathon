/**
 * WhiteboardRenderer — the entry point for the visual subsystem.
 *
 * Flow:
 *   1. VALIDATE the (possibly untrusted) spec with zod. Invalid -> KaTeX
 *      fallback. GUARDRAIL: never white-screen.
 *   2. Set up the draw sequence (reveal orchestration).
 *   3. Route by primitive to the right track renderer.
 *   4. Drive reveals with the MOCK voice (timer on syncCues). The real cloned
 *      voice later drives the same `revealStep` — we surface it via onRevealApi.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { validateVisualSpec, fallbackTexFrom } from "../spec/validate";
import type {
  FreeformSceneContent,
  FunctionPlotContent,
  EquationContent,
} from "../spec/visualSpec";
import { useDrawSequence } from "./hooks/useDrawSequence";
import { createMockVoiceDriver, type RevealApi } from "../voice/voiceInterface";
import { FunctionPlot } from "./tracks/FunctionPlot";
import { FreeformScene } from "./tracks/FreeformScene";
import { EquationFallback } from "./tracks/EquationFallback";

interface Props {
  /** Untrusted spec (from LLM or hardcoded example). */
  rawSpec: unknown;
  /** Auto-start the mocked narration cues on mount / spec change. */
  autoPlay?: boolean;
  /** Hands the parent a `revealStep` fn so the real voice can drive reveals. */
  onRevealApi?: (api: RevealApi) => void;
  /** Bumping this key re-triggers playback (used by the Replay button). */
  playToken?: number;
}

export function WhiteboardRenderer({
  rawSpec,
  autoPlay = true,
  onRevealApi,
  playToken = 0,
}: Props) {
  const validation = useMemo(() => validateVisualSpec(rawSpec), [rawSpec]);
  const spec = validation.ok ? validation.spec : null;

  // Hooks must run unconditionally — pass a safe empty sequence when invalid.
  const drawSequence = spec?.drawSequence ?? [];
  const seq = useDrawSequence(drawSequence);

  // Surface revealStep to the parent (for the real voice module).
  const revealApiRef = useRef<RevealApi>({ revealStep: seq.revealStep });
  revealApiRef.current.revealStep = seq.revealStep;
  useEffect(() => {
    onRevealApi?.({ revealStep: (id: string) => revealApiRef.current.revealStep(id) });
  }, [onRevealApi]);

  // Mock voice driver: fire cues on a timer. Re-runs when spec or playToken changes.
  const cues = spec?.syncCues ?? [];
  const play = useCallback(() => {
    seq.reset();
    const driver = createMockVoiceDriver(cues, {
      revealStep: (id) => seq.revealStep(id),
    });
    // Start on the next frame so reset() has applied.
    const raf = requestAnimationFrame(() => driver.start());
    return () => {
      cancelAnimationFrame(raf);
      driver.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, playToken]);

  useEffect(() => {
    if (!autoPlay || !spec) return;
    const cleanup = play();
    return cleanup;
  }, [autoPlay, spec, play]);

  // ---- Invalid spec: KaTeX fallback (guardrail) ----
  if (!spec) {
    return (
      <EquationFallback
        tex={fallbackTexFrom(rawSpec)}
        isFallback
        note={validation.ok ? undefined : validation.error}
      />
    );
  }

  // ---- Route by primitive ----
  switch (spec.primitive) {
    case "function_plot":
      return (
        <FunctionPlot
          content={spec.content as unknown as FunctionPlotContent}
          annotations={spec.annotations ?? []}
          drawSequence={spec.drawSequence}
          state={seq}
        />
      );
    case "freeform_scene":
      return (
        <FreeformScene
          content={spec.content as unknown as FreeformSceneContent}
          drawSequence={spec.drawSequence}
          state={seq}
        />
      );
    case "equation":
      return <EquationFallback tex={(spec.content as unknown as EquationContent).tex} />;
    default:
      // Known-but-unimplemented primitive (vector_diagram, geometry,
      // number_line come in Phase 6) -> degrade gracefully.
      return (
        <EquationFallback
          tex={fallbackTexFrom(rawSpec)}
          isFallback
          note={`primitive "${spec.primitive}" not yet implemented`}
        />
      );
  }
}
