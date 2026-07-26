/**
 * FunctionPlot — Track 1 (deterministic) renderer.
 *
 * Given a `function_plot` spec, renders a Mafs coordinate plane, DRAWS THE
 * CURVE ON (an eased parametric t-range with a marker tip riding the leading
 * edge), then reveals an annotated tangent line that grows out of the point.
 *
 * The "draw-on" is pure render layer: it reads `progress[stepId]` (0..1) from
 * useDrawSequence, eases it, and maps it to how much of each element is shown.
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

// Marker inks (kept in sync with index.css).
const CURVE = "#2f5fb0";
const TANGENT = "#c2413b";
const MARKER = "#e08a3c";

/** Ease-out so the stroke decelerates like a real marker landing. */
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
/** Slight overshoot so the tangent "snaps" in with life. */
const easeBack = (t: number) => {
  const c = 1.6;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};

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

  const curveRaw = curveStep ? state.progress[curveStep.id] ?? 0 : 1;
  const tangentRaw = tangentStep ? state.progress[tangentStep.id] ?? 0 : 0;
  const curveP = easeOut(curveRaw);
  const tangentP = Math.max(0, easeBack(tangentRaw));
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
  const drawing = curveRaw > 0.02 && curveRaw < 0.999;

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
    const half = (span / 2.2) * Math.max(0.0001, Math.min(1, tangentP));
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
        <Coordinates.Cartesian
          subdivisions={2}
          xAxis={{ labels: (n) => (n === 0 ? "" : String(n)) }}
          yAxis={{ labels: (n) => (n === 0 ? "" : String(n)) }}
        />

        {/* Curve draws on as curveP goes 0 -> 1. */}
        {curveP > 0 && (
          <Plot.Parametric
            xy={(t) => [t, fn(t)]}
            t={[xMin, tEnd]}
            color={CURVE}
            weight={4}
          />
        )}

        {/* Marker tip riding the leading edge while the curve draws. */}
        {drawing && <Point x={tEnd} y={fn(tEnd)} color={MARKER} />}

        {/* Tangent line grows out of the tangent point. */}
        {tangentSeg && tangentP > 0.01 && (
          <Line.Segment
            point1={tangentSeg.p1}
            point2={tangentSeg.p2}
            color={TANGENT}
            weight={3}
          />
        )}

        {/* Tangent point + label appear last. */}
        {tangentSeg && pointRevealed && (
          <>
            <Point x={tangentSeg.px} y={tangentSeg.py} color={TANGENT} />
            {tangent?.label && (
              <Text x={tangentSeg.px} y={tangentSeg.py} attach="nw" color={TANGENT} size={18}>
                {tangent.label}
              </Text>
            )}
          </>
        )}
      </Mafs>
    </div>
  );
}
