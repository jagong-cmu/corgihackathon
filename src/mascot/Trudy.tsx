/**
 * Trudy — the authored corgi mascot rig. (Phase 4 builds this out fully.)
 *
 * DESIGN CONTRACT (do not change lightly — the freeform renderer depends on it):
 *   - Component-based SVG with SEPARATE NAMED PARTS: body, head, ears, eyes,
 *     mouth, tail, plus props/labels.
 *   - A small set of POSE states (e.g. "idle" | "wave" | "point" | "cheer")
 *     and EXPRESSION states (e.g. "neutral" | "happy" | "think").
 *   - Parts are animated deterministically with animejs (no generative SVG on
 *     the demo path), so the mascot is consistent turn-to-turn.
 *
 * This stub renders a recognizable-but-minimal Trudy so the freeform scene and
 * layout can be wired now; Phase 4 replaces the placeholder art + adds animejs
 * pose/expression transitions.
 */
export type TrudyPose = "idle" | "wave" | "point" | "cheer";
export type TrudyExpression = "neutral" | "happy" | "think";

interface Props {
  pose?: TrudyPose;
  expression?: TrudyExpression;
  size?: number;
}

// TODO(Phase 4): replace placeholder shapes with the real authored rig art.
// TODO(Phase 4): drive part transforms (ear tilt, tail wag, arm wave) via animejs.
// TODO(Phase 4): map pose/expression -> per-part target transforms + morphs.
export function Trudy({ pose = "idle", expression = "neutral", size = 220 }: Props) {
  return (
    <svg
      className={`trudy trudy-pose-${pose} trudy-expr-${expression}`}
      width={size}
      height={size}
      viewBox="0 0 220 220"
      role="img"
      aria-label={`Trudy the corgi (${pose}, ${expression})`}
    >
      {/* body */}
      <g id="trudy-body">
        <ellipse cx="110" cy="150" rx="62" ry="44" fill="#f4a24c" />
        <ellipse cx="110" cy="160" rx="40" ry="26" fill="#fbe0c3" />
      </g>
      {/* tail */}
      <g id="trudy-tail">
        <ellipse cx="168" cy="140" rx="16" ry="10" fill="#f4a24c" />
      </g>
      {/* head */}
      <g id="trudy-head">
        <circle cx="88" cy="92" r="42" fill="#f4a24c" />
        <ellipse cx="88" cy="104" rx="26" ry="18" fill="#fbe0c3" />
      </g>
      {/* ears */}
      <g id="trudy-ears">
        <polygon points="58,58 70,20 84,60" fill="#e07d2f" />
        <polygon points="118,58 106,20 92,60" fill="#e07d2f" />
      </g>
      {/* eyes (expression-driven in Phase 4) */}
      <g id="trudy-eyes">
        <circle cx="74" cy="86" r="5" fill="#2b2b2b" />
        <circle cx="102" cy="86" r="5" fill="#2b2b2b" />
      </g>
      {/* mouth (expression-driven in Phase 4) */}
      <g id="trudy-mouth">
        <path
          d="M 78 108 Q 88 118 98 108"
          stroke="#2b2b2b"
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
