/**
 * `graph` — functions, points, tangents, and shaded regions on a Mafs plane.
 *
 * The draw-on animation is a render-layer effect and always was: the curve is
 * plotted over a parametric t-range that grows from the left edge, with a marker
 * tip riding the leading edge. The agent never sends animation — it sends a
 * spec, and the moment it lands the curve draws itself in ~700ms. That is what
 * keeps a graph feeling authored rather than pasted, at zero generation cost.
 *
 * Tangents are computed by central difference (`derivativeAt`) rather than
 * symbolically. §6.4-adjacent reasoning: the number on screen must match the
 * curve on screen, and one evaluator guarantees that where a symbolic
 * differentiator and a numeric plotter would eventually disagree.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Mafs, Coordinates, Plot, Line, Point, Polygon, Text } from "mafs";
import type { GraphSpec } from "@tutor/canvas-protocol";
import { compileFn, derivativeAt, samplePoints, type NumericFn } from "../mathfn";

/** Marker inks, kept in sync with index.css. */
const INKS = ["#2f5fb0", "#c2413b", "#2f7d4f", "#7a4fb0", "#b06a1f", "#3d7f8c"];
const TANGENT = "#c2413b";
const MARKER = "#e08a3c";

const DRAW_MS = 700;

/**
 * Plot size in logical board units.
 *
 * Passed to Mafs as explicit props rather than left to CSS. Mafs sizes its own
 * SVG and a height override in a stylesheet only stretches the element, not the
 * coordinate mapping inside it — which shows up as a plot whose axes are right
 * and whose curve is cropped.
 */
const PLOT_WIDTH = 330;
const PLOT_HEIGHT = 220;

/** Ease-out, so the stroke decelerates like a marker landing. */
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

interface Props {
  id: string;
  spec: GraphSpec;
  parameters: Record<string, number>;
  onParameterChange(name: string, value: number): void;
}

interface Compiled {
  fn: NumericFn | null;
  error: string | null;
  color: string;
  label?: string;
  domain?: [number, number];
  expr: string;
}

export function GraphShape({ id, spec, parameters, onParameterChange }: Props) {
  const progress = useDrawOn(DRAW_MS);

  const [xMin, xMax] = spec.xRange ?? [-10, 10];
  const [yMin, yMax] = spec.yRange ?? [-10, 10];

  const compiled = useMemo<Compiled[]>(
    () =>
      (spec.functions ?? []).map((f, i) => {
        try {
          return {
            fn: compileFn(f.expr, parameters),
            error: null,
            color: f.color ?? INKS[i % INKS.length],
            label: f.label,
            domain: f.domain,
            expr: f.expr,
          };
        } catch (err) {
          return {
            fn: null,
            error: (err as Error).message,
            color: f.color ?? INKS[i % INKS.length],
            label: f.label,
            domain: f.domain,
            expr: f.expr,
          };
        }
      }),
    [spec.functions, parameters],
  );

  const broken = compiled.filter((c) => c.fn === null);
  const drawn = easeOut(progress);

  return (
    <div className="shape shape-graph" data-shape-id={id}>
      <div className="graph-canvas">
        <Mafs
          width={PLOT_WIDTH}
          height={PLOT_HEIGHT}
          viewBox={{ x: [xMin, xMax], y: [yMin, yMax] }}
          preserveAspectRatio={false}
          pan={false}
        >
          <Coordinates.Cartesian
            subdivisions={spec.showGrid === false ? undefined : 2}
            xAxis={{ labels: (n) => (n === 0 ? "" : String(n)) }}
            yAxis={{ labels: (n) => (n === 0 ? "" : String(n)) }}
          />

          {/* Shaded regions sit under the curves that bound them. */}
          {(spec.shaded ?? []).map((region, i) => {
            const target = compiled[region.fnIndex];
            if (!target?.fn || drawn < 0.99) return null;
            const under = samplePoints(target.fn, region.from, region.to, 48);
            if (under.length < 2) return null;
            return (
              <Polygon
                key={`shade-${i}`}
                points={[[region.from, 0], ...under, [region.to, 0]]}
                color={target.color}
                fillOpacity={0.16}
                strokeOpacity={0}
              />
            );
          })}

          {compiled.map((c, i) => {
            if (!c.fn) return null;
            const [from, to] = c.domain ?? [xMin, xMax];
            // The draw-on: the plotted t-range grows left to right.
            const tEnd = from + Math.max(0.0001, drawn) * (to - from);
            return (
              <Plot.Parametric
                key={`fn-${i}`}
                xy={(t) => [t, c.fn!(t)]}
                t={[from, tEnd]}
                color={c.color}
                weight={3.5}
              />
            );
          })}

          {/* Marker tip on the leading edge, only while it is moving. */}
          {progress > 0.02 && progress < 0.999 && compiled[0]?.fn && (
            <MarkerTip fn={compiled[0].fn} from={compiled[0].domain?.[0] ?? xMin}
                       to={compiled[0].domain?.[1] ?? xMax} drawn={drawn} />
          )}

          {/* Everything annotating the curve waits for the curve to exist. */}
          {drawn > 0.98 && (
            <>
              {(spec.tangents ?? []).map((tangent, i) => {
                const target = compiled[tangent.fnIndex];
                if (!target?.fn) return null;
                const y = target.fn(tangent.at);
                if (!Number.isFinite(y)) return null;
                const slope = derivativeAt(target.fn, tangent.at);
                const half = (xMax - xMin) / 5;
                return (
                  <Line.Segment
                    key={`tan-${i}`}
                    point1={[tangent.at - half, y - slope * half]}
                    point2={[tangent.at + half, y + slope * half]}
                    color={TANGENT}
                    weight={2.5}
                  />
                );
              })}
              {(spec.tangents ?? []).map((tangent, i) => {
                const target = compiled[tangent.fnIndex];
                if (!target?.fn) return null;
                const y = target.fn(tangent.at);
                if (!Number.isFinite(y)) return null;
                return (
                  <g key={`tanpt-${i}`}>
                    <Point x={tangent.at} y={y} color={TANGENT} />
                    {tangent.label && (
                      <Text x={tangent.at} y={y} attach="nw" color={TANGENT} size={16}>
                        {tangent.label}
                      </Text>
                    )}
                  </g>
                );
              })}

              {(spec.points ?? []).map((p, i) => (
                <g key={`pt-${i}`}>
                  <Point x={p.x} y={p.y} color={INKS[0]} />
                  {p.label && (
                    <Text x={p.x} y={p.y} attach="ne" color={INKS[0]} size={16}>
                      {p.label}
                    </Text>
                  )}
                </g>
              ))}
            </>
          )}
        </Mafs>
      </div>

      {(spec.xLabel || spec.yLabel) && (
        <div className="graph-axis-labels">
          {spec.yLabel && <span className="axis-y">{spec.yLabel}</span>}
          {spec.xLabel && <span className="axis-x">{spec.xLabel}</span>}
        </div>
      )}

      {/* Draggable parameters. Changing one re-plots locally and tells the
          agent, so "what happens if a goes negative" is answerable by doing it. */}
      {(spec.parameters ?? []).length > 0 && (
        <div className="graph-params">
          {(spec.parameters ?? []).map((p) => (
            <label key={p.name} className="graph-param">
              <span className="param-name">{p.name}</span>
              <input
                type="range"
                min={p.min}
                max={p.max}
                step={p.step ?? (p.max - p.min) / 100}
                value={parameters[p.name] ?? p.value}
                onChange={(e) => onParameterChange(p.name, Number(e.target.value))}
              />
              <span className="param-value">{(parameters[p.name] ?? p.value).toFixed(2)}</span>
            </label>
          ))}
        </div>
      )}

      {broken.length > 0 && (
        // Never a blank plot: say what could not be drawn and show the source.
        <div className="shape-note" title={broken[0].error ?? undefined}>
          couldn't plot {broken.map((b) => b.expr).join(", ")}
        </div>
      )}

      {(spec.functions ?? []).some((f) => f.label) && (
        <ul className="graph-legend">
          {compiled.map((c, i) =>
            c.label ? (
              <li key={i}>
                <span className="swatch" style={{ background: c.color }} />
                {c.label}
              </li>
            ) : null,
          )}
        </ul>
      )}
    </div>
  );
}

function MarkerTip({
  fn,
  from,
  to,
  drawn,
}: {
  fn: NumericFn;
  from: number;
  to: number;
  drawn: number;
}) {
  const x = from + drawn * (to - from);
  const y = fn(x);
  if (!Number.isFinite(y)) return null;
  return <Point x={x} y={y} color={MARKER} />;
}

/** 0 -> 1 over `durationMs`, once, on mount. */
function useDrawOn(durationMs: number): number {
  const [progress, setProgress] = useState(0);
  const startedRef = useRef<number | null>(null);

  useEffect(() => {
    let frame = 0;
    const step = (now: number) => {
      startedRef.current ??= now;
      const t = Math.min(1, (now - startedRef.current) / durationMs);
      setProgress(t);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [durationMs]);

  return progress;
}
