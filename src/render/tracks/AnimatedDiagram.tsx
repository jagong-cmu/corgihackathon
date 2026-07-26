/**
 * AnimatedDiagram — illustrative, ANIMATED concept diagram renderer.
 *
 * Draws a small SVG scene (a "whiteboard sketch") for explaining a concept —
 * e.g. Newton's 2nd law as a ball pushed by a force arrow that then accelerates.
 *
 * Like FunctionPlot, this is a PURE function of `state.progress[stepId]`: no
 * timers, no animejs, no setTimeout. Each element reads its own reveal progress
 * `p` (0..1) from useDrawSequence and maps it to how much of itself is shown —
 * arrows/lines GROW ON toward their tip, balls slide (motion) or scale/fade in,
 * boxes/labels/dots fade in. Reveal order therefore drives the animation.
 */
import type { DrawStep } from "../../spec/visualSpec";
import type { DrawSequenceState } from "../hooks/useDrawSequence";
import type { AnimatedDiagramContent } from "../../spec/animatedDiagram";

interface Props {
  content: AnimatedDiagramContent;
  drawSequence: DrawStep[];
  state: DrawSequenceState;
}

type Pt = [number, number];

/** Marker inks (kept in sync with FunctionPlot / index.css). */
const COLORS = {
  blue: "#2f5fb0",
  berry: "#c2413b",
  sage: "#5f7d59",
  amber: "#e08a3c",
  ink: "#2c2723",
} as const;

/** Ease-out so motion/reveals decelerate like a real marker landing. */
const ease = (t: number): number => 1 - Math.pow(1 - t, 3);

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpPt = (a: Pt, b: Pt, t: number): Pt => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];

/** Lighten a hex color toward white for subtle highlights. */
function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const to2 = (c: number) => c.toString(16).padStart(2, "0");
  return `#${to2(mix(r))}${to2(mix(g))}${to2(mix(b))}`;
}

export function AnimatedDiagram({ content, state }: Props) {
  const [W, H] = content.viewBox ?? [100, 60];
  const anyRevealed = content.elements.some(
    (el) => (state.progress[el.id] ?? (state.isRevealed(el.id) ? 1 : 0)) > 0
  );

  return (
    <div className="animated-diagram" style={{ width: "100%", height: "100%" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        width="100%"
        height="100%"
      >
        {content.elements.map((el) => {
          const raw = state.progress[el.id] ?? (state.isRevealed(el.id) ? 1 : 0);
          const p = clamp01(raw);
          if (p <= 0) return null; // appears in reveal order

          const color = COLORS[el.color ?? "ink"];
          const e = ease(p);

          switch (el.kind) {
            case "arrow":
            case "line": {
              const from = el.from ?? el.at ?? [0, 0];
              const to = el.to ?? el.at ?? from;
              // Grow-on: drawn tip travels from `from` to `from + p*(to-from)`.
              const tip = lerpPt(from, to, e);
              const mid: Pt = [(from[0] + tip[0]) / 2, (from[1] + tip[1]) / 2];
              const dx = to[0] - from[0];
              const dy = to[1] - from[1];
              const len = Math.hypot(dx, dy) || 1;
              const ux = dx / len;
              const uy = dy / len;
              // Arrowhead: small triangle at the current drawn tip.
              const head = 3.6;
              const back: Pt = [tip[0] - ux * head, tip[1] - uy * head];
              const nx = -uy;
              const ny = ux;
              const h1: Pt = [back[0] + nx * (head * 0.6), back[1] + ny * (head * 0.6)];
              const h2: Pt = [back[0] - nx * (head * 0.6), back[1] - ny * (head * 0.6)];
              return (
                <g key={el.id}>
                  <line
                    x1={from[0]}
                    y1={from[1]}
                    x2={tip[0]}
                    y2={tip[1]}
                    stroke={color}
                    strokeWidth={2}
                    strokeLinecap="round"
                  />
                  {el.kind === "arrow" && (
                    <polygon
                      points={`${tip[0]},${tip[1]} ${h1[0]},${h1[1]} ${h2[0]},${h2[1]}`}
                      fill={color}
                    />
                  )}
                  {el.text && (
                    <text
                      x={mid[0]}
                      y={mid[1] - 1.8}
                      fontSize={4.4}
                      fontFamily="system-ui, sans-serif"
                      fontWeight={600}
                      fill={color}
                      textAnchor="middle"
                      opacity={e}
                      style={{ paintOrder: "stroke", stroke: "#fefdfa", strokeWidth: 1, strokeLinejoin: "round" }}
                    >
                      {el.text}
                    </text>
                  )}
                </g>
              );
            }

            case "ball": {
              const at = el.at ?? [0, 0];
              const r = el.r ?? 6;
              // Motion: ease from `at` -> `moveTo` as the step progresses.
              const pos = el.moveTo ? lerpPt(at, el.moveTo, e) : at;
              // If not moving, fade + scale in over the first ~30% of p.
              const intro = el.moveTo ? 1 : clamp01(p / 0.3);
              const introE = ease(intro);
              const rr = r * (el.moveTo ? 1 : lerp(0.4, 1, introE));
              const opacity = el.moveTo ? 1 : introE;
              return (
                <g key={el.id} opacity={opacity}>
                  <circle cx={pos[0]} cy={pos[1]} r={rr} fill={color} />
                  <circle
                    cx={pos[0] - rr * 0.3}
                    cy={pos[1] - rr * 0.3}
                    r={rr * 0.35}
                    fill={lighten(color, 0.55)}
                  />
                  {el.text && (
                    <text
                      x={pos[0]}
                      y={pos[1] - rr - 2}
                      fontSize={4}
                      fontFamily="system-ui, sans-serif"
                      fill={color}
                      textAnchor="middle"
                    >
                      {el.text}
                    </text>
                  )}
                </g>
              );
            }

            case "dot": {
              const at = el.at ?? [0, 0];
              const pos = el.moveTo ? lerpPt(at, el.moveTo, e) : at;
              const r = el.r ?? 3;
              return (
                <circle
                  key={el.id}
                  cx={pos[0]}
                  cy={pos[1]}
                  r={r}
                  fill={color}
                  opacity={e}
                />
              );
            }

            case "box": {
              const at = el.at ?? [0, 0];
              const pos = el.moveTo ? lerpPt(at, el.moveTo, e) : at;
              const w = el.w ?? 12;
              const h = el.h ?? 12;
              return (
                <g key={el.id} opacity={e}>
                  <rect
                    x={pos[0] - w / 2}
                    y={pos[1] - h / 2}
                    width={w}
                    height={h}
                    rx={2}
                    ry={2}
                    fill="none"
                    stroke={color}
                    strokeWidth={2}
                  />
                  {el.text && (
                    <text
                      x={pos[0]}
                      y={pos[1] + 1.5}
                      fontSize={4}
                      fontFamily="system-ui, sans-serif"
                      fill={color}
                      textAnchor="middle"
                    >
                      {el.text}
                    </text>
                  )}
                </g>
              );
            }

            case "icon": {
              // A single emoji (🏀, 🧑, 🚗, 💧…) — the fastest way to make the
              // scene RECOGNIZABLE and on-topic. Pops + fades in, then keeps any
              // moveTo motion so it can visibly accelerate/travel.
              const at = el.at ?? [0, 0];
              const pos = el.moveTo ? lerpPt(at, el.moveTo, e) : at;
              const size = el.size ?? 12;
              const intro = ease(clamp01(p / (el.moveTo ? 0.22 : 0.35)));
              const fs = size * lerp(0.55, 1, intro);
              return (
                <text
                  key={el.id}
                  x={pos[0]}
                  y={pos[1]}
                  fontSize={fs}
                  textAnchor="middle"
                  dominantBaseline="central"
                  opacity={el.moveTo ? 1 : intro}
                >
                  {el.text ?? "●"}
                </text>
              );
            }

            case "label": {
              const at = el.at ?? [0, 0];
              const pos = el.moveTo ? lerpPt(at, el.moveTo, e) : at;
              return (
                <text
                  key={el.id}
                  x={pos[0]}
                  y={pos[1]}
                  fontSize={el.size ?? 5.5}
                  fontFamily="system-ui, sans-serif"
                  fontWeight={600}
                  fill={color}
                  textAnchor="middle"
                  dominantBaseline="central"
                  opacity={e}
                  style={{ paintOrder: "stroke", stroke: "#fefdfa", strokeWidth: 1, strokeLinejoin: "round" }}
                >
                  {el.text ?? ""}
                </text>
              );
            }

            default:
              return null;
          }
        })}

        {/* Caption: centered near the bottom, faded in once anything shows. */}
        {content.caption && anyRevealed && (
          <text
            x={W / 2}
            y={H - 3}
            fontSize={5}
            fontFamily="system-ui, sans-serif"
            fontWeight={600}
            fill={COLORS.ink}
            textAnchor="middle"
            opacity={0.92}
            style={{ paintOrder: "stroke", stroke: "#fefdfa", strokeWidth: 1.4, strokeLinejoin: "round" }}
          >
            {content.caption}
          </text>
        )}
      </svg>
    </div>
  );
}
