/**
 * Trudy — the corgi tutor mascot.
 *
 * A hand-built, front-facing Pembroke Welsh Corgi in a flat-illustration style.
 * The rig is component-based with SEPARATE NAMED PARTS so poses and expressions
 * are driven declaratively from CSS (see index.css → ".trudy ..."), never from
 * generated SVG:
 *   - parts:      #trudy-tail #trudy-body #trudy-arm #trudy-head
 *                 #trudy-ear-l #trudy-ear-r #trudy-eyes #trudy-brow
 *                 #trudy-mouth-neutral #trudy-mouth-smile #trudy-tongue
 *   - idle life:  breathing body, wagging tail, blinking, ear flicks (CSS)
 *   - poses:      idle | wave | point | cheer   (rotate the raised paw)
 *   - expression: neutral | happy | think       (swap mouth / show brow)
 */
export type TrudyPose = "idle" | "wave" | "point" | "cheer";
export type TrudyExpression = "neutral" | "happy" | "think";

interface Props {
  pose?: TrudyPose;
  expression?: TrudyExpression;
  size?: number;
}

export function Trudy({ pose = "idle", expression = "neutral", size = 240 }: Props) {
  return (
    <svg
      className={`trudy trudy-pose-${pose} trudy-expr-${expression}`}
      width={size}
      height={size}
      viewBox="0 0 240 250"
      role="img"
      aria-label={`Trudy the corgi tutor (${pose}, ${expression})`}
    >
      <defs>
        <linearGradient id="coat" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#eaa057" />
          <stop offset="1" stopColor="#d67f2f" />
        </linearGradient>
        <linearGradient id="coatHead" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#eda860" />
          <stop offset="1" stopColor="#e08a3c" />
        </linearGradient>
        <radialGradient id="cheek" cx="50%" cy="40%" r="60%">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#fbf3e6" />
        </radialGradient>
      </defs>

      {/* soft ground shadow */}
      <ellipse cx="120" cy="236" rx="74" ry="12" fill="#c9a06a" opacity="0.35" />

      {/* tail (behind body) */}
      <g id="trudy-tail">
        <path
          d="M56 176 q-26 -6 -30 -30 q18 4 30 16 q6 8 8 20 z"
          fill="url(#coat)"
          stroke="#c46a22"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path d="M30 148 q10 2 18 10" fill="none" stroke="#fbf4e8" strokeWidth="6" strokeLinecap="round" />
      </g>

      {/* body: sitting corgi */}
      <g id="trudy-body">
        <path
          d="M120 132
             C 74 132 60 172 60 196
             C 60 220 84 232 120 232
             C 156 232 180 220 180 196
             C 180 172 166 132 120 132 Z"
          fill="url(#coat)"
          stroke="#c46a22"
          strokeWidth="2.5"
        />
        {/* white chest bib */}
        <path
          d="M120 150
             C 100 150 92 184 96 208
             C 104 224 136 224 144 208
             C 148 184 140 150 120 150 Z"
          fill="#fbf4e8"
        />
        {/* front paws */}
        <ellipse cx="100" cy="224" rx="17" ry="12" fill="#fbf4e8" stroke="#e6d8bf" strokeWidth="1.5" />
        <ellipse cx="140" cy="224" rx="17" ry="12" fill="#fbf4e8" stroke="#e6d8bf" strokeWidth="1.5" />
        <path d="M100 218 v10 M140 218 v10" stroke="#e0cba6" strokeWidth="1.5" strokeLinecap="round" />
      </g>

      {/* raised front paw / arm (pose-driven) */}
      <g id="trudy-arm">
        <path
          d="M168 150
             q22 -2 24 22
             q0 20 -18 24
             q-16 2 -20 -14
             q-4 -20 14 -32 z"
          fill="url(#coat)"
          stroke="#c46a22"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <ellipse cx="184" cy="188" rx="12" ry="10" fill="#fbf4e8" />
      </g>

      {/* head */}
      <g id="trudy-head">
        {/* ears */}
        <g id="trudy-ear-l">
          <path d="M78 62 L58 8 L108 46 Z" fill="url(#coatHead)" stroke="#c46a22" strokeWidth="2.5" strokeLinejoin="round" />
          <path d="M80 54 L68 22 L98 46 Z" fill="#f0b49f" />
        </g>
        <g id="trudy-ear-r">
          <path d="M162 62 L182 8 L132 46 Z" fill="url(#coatHead)" stroke="#c46a22" strokeWidth="2.5" strokeLinejoin="round" />
          <path d="M160 54 L172 22 L142 46 Z" fill="#f0b49f" />
        </g>

        {/* head base */}
        <ellipse cx="120" cy="92" rx="62" ry="56" fill="url(#coatHead)" stroke="#c46a22" strokeWidth="2.5" />

        {/* white cheeks / muzzle */}
        <ellipse cx="96" cy="118" rx="26" ry="24" fill="url(#cheek)" />
        <ellipse cx="144" cy="118" rx="26" ry="24" fill="url(#cheek)" />
        {/* white blaze up the forehead */}
        <path d="M120 46 q-13 30 -8 66 q8 14 16 0 q5 -36 -8 -66 z" fill="#fbf4e8" />

        {/* brow (think expression) */}
        <g id="trudy-brow" opacity="0">
          <path d="M84 70 q10 -6 20 -2" fill="none" stroke="#8a5a2c" strokeWidth="3.5" strokeLinecap="round" />
          <path d="M136 70 q10 -4 20 2" fill="none" stroke="#8a5a2c" strokeWidth="3.5" strokeLinecap="round" />
        </g>

        {/* eyes */}
        <g id="trudy-eyes">
          <ellipse cx="98" cy="94" rx="9" ry="11" fill="#2c2723" />
          <ellipse cx="142" cy="94" rx="9" ry="11" fill="#2c2723" />
          <circle cx="101" cy="90" r="3" fill="#fff" />
          <circle cx="145" cy="90" r="3" fill="#fff" />
        </g>

        {/* nose */}
        <path d="M120 108 q-11 0 -11 8 q0 7 11 9 q11 -2 11 -9 q0 -8 -11 -8 z" fill="#2c2723" />
        <ellipse cx="116" cy="113" rx="3" ry="2" fill="#5b514a" />

        {/* mouth — neutral (default) */}
        <path
          id="trudy-mouth-neutral"
          d="M120 125 q-10 10 -20 4 M120 125 q10 10 20 4"
          fill="none"
          stroke="#7a5330"
          strokeWidth="3"
          strokeLinecap="round"
        />
        {/* mouth — happy open smile */}
        <path
          id="trudy-mouth-smile"
          d="M100 124 q20 26 40 0 q-6 -8 -20 -8 q-14 0 -20 8 z"
          fill="#6b4626"
          opacity="0"
        />
        <path id="trudy-tongue" d="M112 138 q8 12 16 0 q0 10 -8 12 q-8 -2 -8 -12 z" fill="#e8748a" opacity="0" />
      </g>
    </svg>
  );
}
