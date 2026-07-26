/**
 * FunctionPlot — Track 1 (deterministic) renderer.
 *
 * Given a `function_plot` spec, renders a Mafs coordinate plane, DRAWS THE
 * CURVE ON (via an animated parametric t-range), then reveals an annotated
 * tangent line that grows out from the tangent point.
 *
 * The "draw-on" is pure render layer: it reads `progress[stepId]` (0..1) from
 * useDrawSequence and maps it to how much of each element is shown.
 */
import { useMemo } from "react";
import { Mafs, Coordinates, Plot, Line, Point, Text } from "mafs";
import type {
  Annotation,
  DrawStep,
  FunctionPlotContent,
} from "../../spec/visualSpec";
import type { DrawSequenceState } from "../hooks/useDrawSequence";
import { compileFn, derivativeAt } from "../mathfn";
import { EquationFallback } from "./EquationFallback";

interface Props {
  content: FunctionPlotContent;
  annotations: Annotation[];
  drawSequence: DrawStep[];
  state: DrawSequenceState;
}

/** Find a draw step by its semantic `element` name (robust to id naming). */
function stepByElement(steps: DrawStep[], element: string): DrawStep | undefined {
  return steps.find((s) => s.element === element);
}

export function FunctionPlot({ content, annotations, drawSequence, state }: Props) {
  const compiled = useMemo(() => {
    try {
      return { fn: compileFn(content.fn), error: null as string | null };
    } catch (e) {
      return { fn: null, error: (e as Error).message };
    }
  }, [content.fn]);

  const [xMin, xMax] = content.domain;
  const range = content.range ?? [xMin, xMax];

  // Resolve each element's reveal progress (0 if not yet revealed).
  const curveStep = stepByElement(drawSequence, "function-curve");
  const tangentStep = stepByElement(drawSequence, "tangent-line");
  const pointStep = stepByElement(drawSequence, "tangent-point");

  const curveP = curveStep ? state.progress[curveStep.id] ?? 0 : 1;
  const tangentP = tangentStep ? state.progress[tangentStep.id] ?? 0 : 0;
  const pointRevealed = pointStep ? state.isRevealed(pointStep.id) : false;

  // Tangent annotation (first one of type "tangent").
  const tangent = annotations.find((a) => a.type === "tangent");
  const tangentX = typeof tangent?.at === "number" ? tangent.at : null;

  // If the function couldn't compile, degrade to the KaTeX view (never blank).
  if (!compiled.fn) {
    return (
      <EquationFallback
        tex={`y = ${content.fn}`}
        isFallback
        note={compiled.error ?? "could not compile function"}
      />
    );
  }
  const fn = compiled.fn;

  // Curve draw-on: parametric t-range grows from xMin to xMin+curveP*span.
  const span = xMax - xMin;
  const tEnd = xMin + Math.max(0.0001, curveP) * span;

  // Tangent geometry.
  let tangentSeg: null | {
    p1: [number, number];
    p2: [number, number];
    px: number;
    py: number;
  } = null;
  if (tangentX !== null) {
    const py = fn(tangentX);
    const m = derivativeAt(fn, tangentX);
    // Half-length of the drawn tangent segment, grown by tangentP.
    const half = (span / 2.2) * Math.max(0.0001, tangentP);
    const p1: [number, number] = [tangentX - half, py - m * half];
    const p2: [number, number] = [tangentX + half, py + m * half];
    tangentSeg = { p1, p2, px: tangentX, py };
  }

  return (
    <div className="function-plot" style={{ width: "100%", height: "100%" }}>
      <Mafs
        viewBox={{ x: [xMin, xMax], y: [range[0], range[1]] }}
        preserveAspectRatio={false}
      >
        <Coordinates.Cartesian />

        {/* Curve draws on as curveP goes 0 -> 1. */}
        {curveP > 0 && (
          <Plot.Parametric
            xy={(t) => [t, fn(t)]}
            t={[xMin, tEnd]}
            color="#2563eb"
          />
        )}

        {/* Tangent line grows out of the tangent point. */}
        {tangentSeg && tangentP > 0 && (
          <Line.Segment
            point1={tangentSeg.p1}
            point2={tangentSeg.p2}
            color="#dc2626"
          />
        )}

        {/* Tangent point + label appear last. */}
        {tangentSeg && pointRevealed && (
          <>
            <Point x={tangentSeg.px} y={tangentSeg.py} color="#dc2626" />
            {tangent?.label && (
              <Text x={tangentSeg.px} y={tangentSeg.py} attach="nw" color="#dc2626">
                {tangent.label}
              </Text>
            )}
          </>
        )}
      </Mafs>
    </div>
  );
}
