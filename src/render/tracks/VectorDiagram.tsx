/**
 * VectorDiagram — Track 1 (deterministic) renderer for `vector_diagram`.
 *
 * Draws 2D vectors on a Mafs plane, each GROWING from its tail toward its tip
 * as its reveal step progresses (a marker tip rides the leading head). When
 * `showResultant` is set, a final amber resultant vector (origin → sum of all
 * displacements) snaps in — the payoff for a vector-addition explanation.
 *
 * Draw-on is pure render layer: it reads `progress[stepId]` (0..1) from
 * useDrawSequence and interpolates each vector's visible tip.
 */
import { useMemo } from "react";
import { Mafs, Coordinates, Vector, Point, Text } from "mafs";
import type { DrawStep, VectorDiagramContent } from "../../spec/visualSpec";
import type { DrawSequenceState } from "../hooks/useDrawSequence";

// Marker inks (kept in sync with index.css).
const INK: Record<string, string> = {
  blue: "#2f5fb0",
  berry: "#c2413b",
  sage: "#5f7d59",
  amber: "#e08a3c",
};
const CYCLE = ["blue", "berry", "sage"];
const RESULTANT = "#e08a3c";

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

interface Props {
  content: VectorDiagramContent;
  drawSequence: DrawStep[];
  state: DrawSequenceState;
}

type Pt = [number, number];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const lerp = (a: Pt, b: Pt, t: number): Pt => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

export function VectorDiagram({ content, drawSequence, state }: Props) {
  const vectors = content.vectors ?? [];

  // Auto-fit a symmetric view around every tail/tip (+ the resultant tip).
  const extent = useMemo(() => {
    if (content.extent) return content.extent;
    let m = 1;
    const pts: Pt[] = [];
    for (const v of vectors) {
      pts.push(v.tail ?? [0, 0], v.tip);
    }
    if (content.showResultant) {
      pts.push(
        vectors.reduce<Pt>((acc, v) => add(acc, sub(v.tip, v.tail ?? [0, 0])), [0, 0])
      );
    }
    for (const [x, y] of pts) m = Math.max(m, Math.abs(x), Math.abs(y));
    return Math.ceil(m + 1);
  }, [vectors, content.extent, content.showResultant]);

  const stepFor = (element: string) => drawSequence.find((s) => s.element === element);

  const resultant = useMemo<Pt>(
    () => vectors.reduce<Pt>((acc, v) => add(acc, sub(v.tip, v.tail ?? [0, 0])), [0, 0]),
    [vectors]
  );
  const resStep = stepFor("resultant");
  const resP = resStep ? easeOut(state.progress[resStep.id] ?? 0) : 0;

  return (
    <div className="function-plot" style={{ width: "100%", height: "100%" }}>
      <Mafs viewBox={{ x: [-extent, extent], y: [-extent, extent] }} preserveAspectRatio={false}>
        <Coordinates.Cartesian
          subdivisions={2}
          xAxis={{ labels: (n) => (n === 0 ? "" : String(n)) }}
          yAxis={{ labels: (n) => (n === 0 ? "" : String(n)) }}
        />

        {vectors.map((v, i) => {
          const tail = v.tail ?? [0, 0];
          const step = stepFor(`vector-${v.id}`);
          const raw = step ? state.progress[step.id] ?? 0 : 1;
          const p = easeOut(raw);
          if (p <= 0.001) return null;
          const head = lerp(tail, v.tip, p);
          const color = INK[v.color ?? CYCLE[i % CYCLE.length]] ?? INK.blue;
          const drawing = raw > 0.02 && raw < 0.999;
          const labeled = raw > 0.6 && v.label;
          return (
            <g key={v.id}>
              <Vector tail={tail} tip={head} color={color} />
              {drawing && <Point x={head[0]} y={head[1]} color={color} />}
              {labeled && (
                <Text x={head[0]} y={head[1]} attach="ne" color={color} size={18}>
                  {v.label!}
                </Text>
              )}
            </g>
          );
        })}

        {content.showResultant && resP > 0.01 && (
          <>
            <Vector tail={[0, 0]} tip={lerp([0, 0], resultant, resP)} color={RESULTANT} />
            {resP > 0.6 && (
              <Text
                x={resultant[0] / 2}
                y={resultant[1] / 2}
                attach="sw"
                color={RESULTANT}
                size={18}
              >
                sum
              </Text>
            )}
          </>
        )}
      </Mafs>
    </div>
  );
}
