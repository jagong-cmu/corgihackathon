/**
 * `write_steps` — a worked solution, revealed a line at a time.
 *
 * The reveal is the whole point of the action. §5.2 tells the model "do not
 * narrate steps that aren't on the board", so lines appear as they are spoken
 * rather than arriving as a finished wall of algebra the learner reads ahead in.
 * Pacing lives in the reducer (`STEP_REVEAL_MS`) because it is state, not
 * presentation — a `highlight` on `line:2` pulls the reveal forward there.
 *
 * Lines may contain inline math between `$`, which is how a model naturally
 * writes a derivation. Anything outside the delimiters stays plain text.
 */

import { useMemo } from "react";
import katex from "katex";

interface Props {
  id: string;
  lines: string[];
  revealed: number;
  highlightedSub?: string | null;
  highlightColor?: string;
}

/** Render `text with $x^2$ inline` into HTML, typesetting only the math. */
function renderInline(line: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return line
    .split(/(\$[^$]+\$)/g)
    .map((part) => {
      if (part.startsWith("$") && part.endsWith("$") && part.length > 2) {
        try {
          return katex.renderToString(part.slice(1, -1), {
            throwOnError: false,
            errorColor: "#c2413b",
          });
        } catch {
          return escape(part);
        }
      }
      return escape(part);
    })
    .join("");
}

export function StepsShape({ id, lines, revealed, highlightedSub, highlightColor }: Props) {
  const html = useMemo(() => lines.map(renderInline), [lines]);

  const highlighted = useMemo(() => {
    if (!highlightedSub?.startsWith("line:")) return -1;
    const index = Number.parseInt(highlightedSub.slice("line:".length), 10);
    return Number.isFinite(index) ? index : -1;
  }, [highlightedSub]);

  return (
    <ol className="shape shape-steps" data-shape-id={id}>
      {lines.map((_, i) => {
        const visible = i < revealed;
        return (
          <li
            key={i}
            className={[
              "step-line",
              visible ? "is-visible" : "is-pending",
              i === highlighted ? "is-highlighted" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            data-line={i}
            style={
              i === highlighted && highlightColor ? { background: highlightColor } : undefined
            }
            // Unrevealed lines are rendered but hidden rather than omitted, so
            // the shape does not resize under the learner as each line lands.
            aria-hidden={!visible}
          >
            <span className="step-number">{i + 1}</span>
            <span className="step-text" dangerouslySetInnerHTML={{ __html: html[i] }} />
          </li>
        );
      })}
    </ol>
  );
}
