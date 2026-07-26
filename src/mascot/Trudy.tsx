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
 *   - poses:      idle | wave | point | cheer   (rotate the raised paw at the
 *                 shoulder — the arm base overlaps the body so it always reads
 *                 as attached, never a detached blob)
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
          <stop offset="0" stopColor="#efa75f" />
          <stop offset="1" stopColor="#d67f2f" />
        </linearGradient>
        <linearGradient id="coatHead" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f0ac63" />
          <stop offset="1" stopColor="#e08a3c" />
        </linearGradient>
        <radialGradient id="cheek" cx="50%" cy="38%" r="62%">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#fbf3e6" />
        </radialGradient>
      </defs>

      {/* soft ground shadow */}
      <ellipse cx="120" cy="236" rx="72" ry="11" fill="#c39a63" opacity="0.32" />

      {/* tail (behind body) */}
      <g id="trudy-tail">
        <path
          d="M60 182 q-30 -4 -34 -30 q20 3 33 15 q8 8 10 22 z"
          fill="url(#coat)"
          stroke="#c46a22"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <path d="M30 154 q11 2 19 11" fill="none" stroke="#fbf4e8" strokeWidth="6" strokeLinecap="round" />
      </g>

      {/* body: sitting corgi */}
      <g id="trudy-body">
        <path
          d="M120 128
             C 72 128 58 170 58 196
             C 58 222 82 234 120 234
             C 158 234 182 222 182 196
             C 182 170 168 128 120 128 Z"
          fill="url(#coat)"
          stroke="#c46a22"
          strokeWidth="2.5"
        />
        {/* white chest bib */}
        <path
          d="M120 148
             C 98 148 90 184 96 210
             C 106 226 134 226 144 210
             C 150 184 142 148 120 148 Z"
          fill="#fbf4e8"
        />
        {/* front paws */}
        <ellipse cx="100" cy="226" rx="16" ry="11" fill="#fbf4e8" stroke="#e6d8bf" strokeWidth="1.5" />
        <ellipse cx="140" cy="226" rx="16" ry="11" fill="#fbf4e8" stroke="#e6d8bf" strokeWidth="1.5" />
        <path d="M100 220 v10 M140 220 v10" stroke="#e0cba6" strokeWidth="1.5" strokeLinecap="round" />
      </g>

      {/* raised front paw / arm — base overlaps the shoulder so it reads as
          attached; pose rotates it about the shoulder (CSS transform-origin). */}
      <g id="trudy-arm">
        <path
          d="M150 152
             C 150 149 157 145 165 145
             C 185 145 197 158 197 172
             C 197 185 188 193 178 193
             C 167 193 159 186 155 176
             C 150 165 148 160 150 152 Z"
          fill="url(#coat)"
          stroke="#c46a22"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        {/* white paw pad at the waving end */}
        <ellipse cx="181" cy="184" rx="12" ry="10" fill="#fbf4e8" stroke="#e6d8bf" strokeWidth="1.2" />
        <path d="M178 179 v9 M185 179 v9" stroke="#e0cba6" strokeWidth="1.3" strokeLinecap="round" />
      </g>

      {/* head */}
      <g id="trudy-head">
        {/* ears */}
        <g id="trudy-ear-l">
          <path d="M80 60 L60 8 L110 44 Z" fill="url(#coatHead)" stroke="#c46a22" strokeWidth="2.5" strokeLinejoin="round" />
          <path d="M82 52 L70 22 L100 44 Z" fill="#f0b49f" />
        </g>
        <g id="trudy-ear-r">
          <path d="M160 60 L180 8 L130 44 Z" fill="url(#coatHead)" stroke="#c46a22" strokeWidth="2.5" strokeLinejoin="round" />
          <path d="M158 52 L170 22 L140 44 Z" fill="#f0b49f" />
        </g>

        {/* head base */}
        <ellipse cx="120" cy="90" rx="60" ry="54" fill="url(#coatHead)" stroke="#c46a22" strokeWidth="2.5" />

        {/* white cheeks / muzzle */}
        <ellipse cx="95" cy="116" rx="25" ry="23" fill="url(#cheek)" />
        <ellipse cx="145" cy="116" rx="25" ry="23" fill="url(#cheek)" />
        {/* white blaze up the forehead */}
        <path d="M120 46 q-12 29 -8 64 q8 13 16 0 q4 -35 -8 -64 z" fill="#fbf4e8" />

        {/* brow (think expression) */}
        <g id="trudy-brow" opacity="0">
          <path d="M84 70 q10 -6 20 -2" fill="none" stroke="#8a5a2c" strokeWidth="3.5" strokeLinecap="round" />
          <path d="M136 70 q10 -4 20 2" fill="none" stroke="#8a5a2c" strokeWidth="3.5" strokeLinecap="round" />
        </g>

        {/* eyes */}
        <g id="trudy-eyes">
          <ellipse cx="97" cy="93" rx="8.5" ry="10.5" fill="#2c2723" />
          <ellipse cx="143" cy="93" rx="8.5" ry="10.5" fill="#2c2723" />
          <circle cx="100" cy="89" r="3" fill="#fff" />
          <circle cx="146" cy="89" r="3" fill="#fff" />
        </g>

        {/* nose */}
        <path d="M120 106 q-11 0 -11 8 q0 7 11 9 q11 -2 11 -9 q0 -8 -11 -8 z" fill="#2c2723" />
        <ellipse cx="116" cy="111" rx="3" ry="2" fill="#5b514a" />

        {/* mouth — neutral (default) */}
        <path
          id="trudy-mouth-neutral"
          d="M120 123 q-10 10 -20 4 M120 123 q10 10 20 4"
          fill="none"
          stroke="#7a5330"
          strokeWidth="3"
          strokeLinecap="round"
        />
        {/* mouth — happy open smile */}
        <path
          id="trudy-mouth-smile"
          d="M100 122 q20 26 40 0 q-6 -8 -20 -8 q-14 0 -20 8 z"
          fill="#6b4626"
          opacity="0"
        />
        <path id="trudy-tongue" d="M112 136 q8 12 16 0 q0 10 -8 12 q-8 -2 -8 -12 z" fill="#e8748a" opacity="0" />
      </g>
    </svg>
  );
}
