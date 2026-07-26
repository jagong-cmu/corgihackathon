/**
 * `equation` — a typeset equation, with real sub-term addressing.
 *
 * The protocol lets the agent highlight part of an equation: `{shapeId, sub:
 * "term:3"}` means the fourth term. That only works if terms are separately
 * addressable elements, so the LaTeX is split on its top-level operators and
 * each term is typeset into its own element rather than the whole string being
 * rendered as one opaque block.
 *
 * Splitting respects brace depth, so `\frac{a+b}{c}` is one term rather than
 * two — the `+` inside the fraction is not a top-level operator. An equation
 * with no top-level operator (a single fraction, a lone identifier) renders as
 * one term, which is the correct answer rather than a special case.
 */

import { useMemo } from "react";
import katex from "katex";

interface Props {
  id: string;
  latex: string;
  /** Sub-target from a highlight, e.g. "term:3". */
  highlightedSub?: string | null;
  highlightColor?: string;
}

interface Term {
  /** The operator that preceded this term, rendered but never highlighted. */
  op: string | null;
  tex: string;
}

const OPERATORS = new Set(["+", "-", "=", "<", ">"]);

/**
 * Split LaTeX into top-level terms.
 *
 * Depth counting covers the case that matters: an operator inside `{...}`
 * belongs to a fraction, root, or subscript and is not a term boundary. A `-`
 * at the very start or straight after another operator is a sign, not a
 * separator, and stays attached to its term.
 */
export function splitTerms(latex: string): Term[] {
  const terms: Term[] = [];
  let depth = 0;
  let current = "";
  let pendingOp: string | null = null;
  let lastMeaningful = "";

  const push = () => {
    if (current.trim()) {
      terms.push({ op: pendingOp, tex: current.trim() });
      current = "";
    }
  };

  for (let i = 0; i < latex.length; i += 1) {
    const ch = latex[i];

    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;

    // A backslash command may contain nothing that splits; copy it whole so
    // `\leq` is never cut at its `\l`.
    if (ch === "\\") {
      const match = /^\\[a-zA-Z]+/.exec(latex.slice(i));
      const token = match ? match[0] : latex.slice(i, i + 2);
      current += token;
      lastMeaningful = token;
      i += token.length - 1;
      continue;
    }

    if (depth === 0 && OPERATORS.has(ch)) {
      const unary = ch === "-" && (lastMeaningful === "" || OPERATORS.has(lastMeaningful));
      if (!unary) {
        push();
        pendingOp = ch;
        lastMeaningful = ch;
        continue;
      }
    }

    current += ch;
    if (ch.trim()) lastMeaningful = ch;
  }
  push();

  return terms.length ? terms : [{ op: null, tex: latex }];
}

function render(tex: string): string {
  try {
    return katex.renderToString(tex, {
      displayMode: false,
      throwOnError: false,
      errorColor: "#c2413b",
    });
  } catch {
    // KaTeX with throwOnError:false almost never reaches here, but a board that
    // throws is a lesson that ends (§13).
    return `<span class="katex-error">${tex}</span>`;
  }
}

export function EquationShape({ id, latex, highlightedSub, highlightColor }: Props) {
  const terms = useMemo(() => splitTerms(latex), [latex]);
  const html = useMemo(() => terms.map((t) => render(t.tex)), [terms]);

  const highlighted = useMemo(() => {
    if (!highlightedSub?.startsWith("term:")) return -1;
    const index = Number.parseInt(highlightedSub.slice("term:".length), 10);
    return Number.isFinite(index) ? index : -1;
  }, [highlightedSub]);

  return (
    <div className="shape shape-equation" data-shape-id={id}>
      <div className="equation-terms">
        {terms.map((term, i) => (
          <span key={i} className="equation-term-group">
            {term.op && <span className="equation-op">{term.op}</span>}
            <span
              className={`equation-term${i === highlighted ? " is-highlighted" : ""}`}
              data-term={i}
              style={
                i === highlighted && highlightColor
                  ? { background: highlightColor }
                  : undefined
              }
              // KaTeX output is markup from a trusted library.
              dangerouslySetInnerHTML={{ __html: html[i] }}
            />
          </span>
        ))}
      </div>
    </div>
  );
}
