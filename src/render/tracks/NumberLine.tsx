/**
 * NumberLine — Track 1 (deterministic) renderer for `number_line`.
 *
 * A bespoke SVG number line (cleaner than a full Mafs grid for 1-D work). The
 * axis DRAWS ON left→right, an optional interval band sweeps in, then labeled
 * points pop (hollow = excluded endpoint). Great for intervals, inequalities,
 * and integer sets.
 *
 * Draw-on is pure render layer: reads `progress[stepId]` / `isRevealed` from
 * useDrawSequence. Element names: "line", "interval", "points".
 */
import type { DrawStep, NumberLineContent } from "../../spec/visualSpec";
import type { DrawSequenceState } from "../hooks/useDrawSequence";

const INK: Record<string, string> = {
  blue: "#2f5fb0",
  berry: "#c2413b",
  sage: "#5f7d59",
  amber: "#e08a3c",
};

const W = 1000;
const H = 210;
const PAD = 70;
const BASE = 132; // baseline y
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

interface Props {
  content: NumberLineContent;
  drawSequence: DrawStep[];
  state: DrawSequenceState;
}

export function NumberLine({ content, drawSequence, state }: Props) {
  const { min, max } = content;
  const step = content.step && content.step > 0 ? content.step : 1;
  const span = max - min || 1;
  const innerW = W - 2 * PAD;
  const px = (v: number) => PAD + ((v - min) / span) * innerW;

  const stepFor = (el: string) => drawSequence.find((s) => s.element === el);

  const lineStep = stepFor("line");
  const lineRaw = lineStep ? state.progress[lineStep.id] ?? 0 : 1;
  const lineP = easeOut(lineRaw);
  const leadX = PAD + lineP * innerW;
  const drawing = lineRaw > 0.02 && lineRaw < 0.999;

  const intervalStep = stepFor("interval");
  const intervalP = intervalStep ? easeOut(state.progress[intervalStep.id] ?? 0) : 0;

  const pointsStep = stepFor("points");
  const pointsIn = pointsStep ? state.isRevealed(pointsStep.id) : true;

  // Ticks at each step value; only reveal those the drawing head has passed.
  const ticks: number[] = [];
  for (let v = min; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);

  const interval = content.interval;
  const intervalColor = interval ? INK[interval.color ?? "amber"] ?? INK.amber : INK.amber;

  return (
    <div className="numberline">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img">
        {/* interval band (behind the axis) */}
        {interval && intervalP > 0.01 && (
          <g>
            {(() => {
              const x0 = px(interval.from);
              const x1 = px(interval.from) + (px(interval.to) - px(interval.from)) * intervalP;
              return (
                <>
                  <rect
                    x={Math.min(x0, x1)}
                    y={BASE - 16}
                    width={Math.abs(x1 - x0)}
                    height={32}
                    rx={16}
                    fill={intervalColor}
                    opacity={0.16}
                  />
                  <line
                    x1={x0}
                    y1={BASE}
                    x2={x1}
                    y2={BASE}
                    stroke={intervalColor}
                    strokeWidth={7}
                    strokeLinecap="round"
                    opacity={0.9}
                  />
                  {interval.label && intervalP > 0.7 && (
                    <text
                      x={(px(interval.from) + px(interval.to)) / 2}
                      y={BASE - 30}
                      textAnchor="middle"
                      className="nl-label"
                      fontSize={26}
                      fill={intervalColor}
                      fontWeight={600}
                    >
                      {interval.label}
                    </text>
                  )}
                </>
              );
            })()}
          </g>
        )}

        {/* main axis, drawing left→right */}
        <line
          x1={PAD}
          y1={BASE}
          x2={leadX}
          y2={BASE}
          stroke="#4a4238"
          strokeWidth={3}
          strokeLinecap="round"
        />
        {/* end arrowheads appear once fully drawn */}
        {lineP > 0.995 && (
          <>
            <path d={`M${W - PAD + 2} ${BASE} l-12 -6 v12 z`} fill="#4a4238" />
            <path d={`M${PAD - 2} ${BASE} l12 -6 v12 z`} fill="#4a4238" />
          </>
        )}
        {/* marker tip riding the leading edge */}
        {drawing && <circle cx={leadX} cy={BASE} r={7} fill="#e08a3c" />}

        {/* ticks + numeric labels, revealed as the head passes them */}
        {ticks.map((v) => {
          const x = px(v);
          if (x > leadX + 2) return null;
          return (
            <g key={v}>
              <line x1={x} y1={BASE - 9} x2={x} y2={BASE + 9} stroke="#8c8172" strokeWidth={2} />
              <text
                x={x}
                y={BASE + 34}
                textAnchor="middle"
                className="nl-label"
                fontSize={22}
                fill="#6c6053"
              >
                {v}
              </text>
            </g>
          );
        })}

        {/* labeled points pop in together */}
        {(content.points ?? []).map((pt, i) => {
          const x = px(pt.x);
          const color = INK[pt.color ?? "berry"] ?? INK.berry;
          return (
            <g key={`${pt.x}-${i}`} className={`nl-point${pointsIn ? " in" : ""}`}>
              <circle
                cx={x}
                cy={BASE}
                r={9}
                fill={pt.open ? "#fefdfa" : color}
                stroke={color}
                strokeWidth={3}
              />
              {pt.label && (
                <text
                  x={x}
                  y={BASE - 22}
                  textAnchor="middle"
                  className="nl-label"
                  fontSize={24}
                  fill={color}
                  fontWeight={600}
                >
                  {pt.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
