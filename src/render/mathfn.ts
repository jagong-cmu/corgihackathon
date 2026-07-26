/**
 * Tiny, deterministic evaluator for single-variable functions given as strings
 * (e.g. "x^2", "sin(x)", "x^3 - 2*x"). Track 1 is deterministic and
 * parameterized, so we compile the expression once into a numeric function.
 *
 * SECURITY NOTE: we whitelist characters and known Math identifiers before
 * constructing the function, so this is not arbitrary code execution. For a
 * production system, swap in a real expression parser (e.g. mathjs).
 */

const ALLOWED = /^[\sxX0-9+\-*/^().,eE]*$/;

// Math functions/constants callers may use, mapped bare -> Math.*
const MATH_IDENTS = [
  "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
  "sinh", "cosh", "tanh", "sqrt", "cbrt", "abs", "exp",
  "log", "log2", "log10", "sign", "floor", "ceil", "round",
  "min", "max", "pow", "PI", "E",
];

export type NumericFn = (x: number) => number;

/**
 * Compile a function string into (x) => number. Throws on disallowed input so
 * the caller can fall back to the KaTeX view.
 */
export function compileFn(src: string): NumericFn {
  let expr = src.trim();

  // Replace `^` (math power) with `**` (JS power) before the whitelist check
  // rejects it — `^` is allowed in ALLOWED so identifiers survive the pass.
  expr = expr.replace(/\^/g, "**");

  // Guard: only allow safe characters plus known identifiers.
  const stripped = MATH_IDENTS.reduce(
    (acc, id) => acc.replaceAll(id, ""),
    expr
  );
  if (!ALLOWED.test(stripped)) {
    throw new Error(`Unsafe or unsupported expression: ${src}`);
  }

  // Prefix bare Math identifiers with `Math.`
  let jsExpr = expr;
  for (const id of MATH_IDENTS) {
    jsExpr = jsExpr.replace(
      new RegExp(`\\b${id}\\b`, "g"),
      id === "PI" || id === "E" ? `Math.${id}` : `Math.${id}`
    );
  }

  // eslint-disable-next-line no-new-func
  const fn = new Function("x", `"use strict"; return (${jsExpr});`) as NumericFn;

  // Smoke-test the compiled function so bad specs fail fast at compile time.
  const probe = fn(1);
  if (typeof probe !== "number" || Number.isNaN(probe)) {
    // NaN at x=1 isn't necessarily fatal (e.g. log at 0), but a non-number is.
    if (typeof probe !== "number") {
      throw new Error(`Expression did not evaluate to a number: ${src}`);
    }
  }
  return fn;
}

/** Central-difference numeric derivative — deterministic, no symbolic algebra. */
export function derivativeAt(fn: NumericFn, x: number, h = 1e-4): number {
  return (fn(x + h) - fn(x - h)) / (2 * h);
}
