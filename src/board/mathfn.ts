/**
 * A small, deterministic evaluator for the function strings in a `GraphSpec`.
 *
 * `GraphFunction.expr` is plain math syntax written by a model — "x^2 - 4*x + 3",
 * "sin(x)/x", or, when the graph declares parameters, "a*x^2 + b". It is
 * compiled once into a numeric function rather than interpreted per sample,
 * because a plot draws a few hundred points per frame while it animates on.
 *
 * SECURITY: the expression is model-generated, so it is treated as untrusted.
 * Characters are whitelisted and identifiers must be either a known Math name
 * or a parameter the same spec declared, before anything is constructed. A
 * production system should swap this for a real parser (mathjs); the whitelist
 * is what makes the current form defensible rather than an eval.
 */

const ALLOWED = /^[\sxX0-9+\-*/^().,eE]*$/;

/** Math functions and constants an expression may use, bare. */
const MATH_IDENTS = [
  "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
  "sinh", "cosh", "tanh", "sqrt", "cbrt", "abs", "exp",
  "log", "log2", "log10", "sign", "floor", "ceil", "round",
  "min", "max", "pow", "PI", "E",
];

/** A parameter name has to be a plain identifier we can safely bind. */
const PARAM_NAME = /^[a-z][a-z0-9_]{0,31}$/i;

export type NumericFn = (x: number) => number;

export class ExpressionError extends Error {}

/**
 * Compile an expression into `(x) => number`, binding any declared parameters
 * to the values given.
 *
 * Throws `ExpressionError` on anything unsafe or unparseable so the caller can
 * fall back to showing the expression as text — a graph that cannot be plotted
 * should still tell the learner what it was going to plot.
 */
export function compileFn(src: string, params: Record<string, number> = {}): NumericFn {
  const names = Object.keys(params);
  for (const name of names) {
    if (!PARAM_NAME.test(name)) {
      throw new ExpressionError(`unsafe parameter name: ${name}`);
    }
    if (MATH_IDENTS.includes(name) || name === "x") {
      throw new ExpressionError(`parameter ${name} shadows a built-in`);
    }
  }

  let expr = src.trim();
  if (!expr) throw new ExpressionError("empty expression");

  // `^` means power here, not xor. Rewritten before the whitelist runs.
  expr = expr.replace(/\^/g, "**");

  // Strip every identifier we are willing to accept; whatever is left must be
  // arithmetic. An unknown name therefore fails the character test rather than
  // reaching the Function constructor.
  const stripped = [...MATH_IDENTS, ...names].reduce(
    (acc, id) => acc.replace(new RegExp(`\\b${id}\\b`, "g"), ""),
    expr,
  );
  if (!ALLOWED.test(stripped)) {
    throw new ExpressionError(`unsupported expression: ${src}`);
  }

  const jsExpr = MATH_IDENTS.reduce(
    (acc, id) => acc.replace(new RegExp(`\\b${id}\\b`, "g"), `Math.${id}`),
    expr,
  );

  let fn: (x: number, ...values: number[]) => number;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function("x", ...names, `"use strict"; return (${jsExpr});`) as typeof fn;
  } catch (err) {
    throw new ExpressionError(`could not compile ${src}: ${(err as Error).message}`);
  }

  const values = names.map((name) => params[name]);
  const bound: NumericFn = (x) => fn(x, ...values);

  // Smoke-test so a malformed spec fails at compile time rather than as a
  // silently blank plot. NaN is legitimate (log at 0); a non-number is not.
  if (typeof bound(1) !== "number") {
    throw new ExpressionError(`expression did not evaluate to a number: ${src}`);
  }
  return bound;
}

/** Central-difference numeric derivative — deterministic, no symbolic algebra. */
export function derivativeAt(fn: NumericFn, x: number, h = 1e-4): number {
  return (fn(x + h) - fn(x - h)) / (2 * h);
}

/**
 * Sample a function across a range, dropping points it is not defined at.
 *
 * Used for shaded regions, which need explicit polygon vertices. Discontinuities
 * (1/x at zero, sqrt below zero) come back as NaN or Infinity, and a polygon
 * with a NaN vertex renders as nothing at all rather than as a gap.
 */
export function samplePoints(
  fn: NumericFn,
  from: number,
  to: number,
  steps = 64,
): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i += 1) {
    const x = from + ((to - from) * i) / steps;
    const y = fn(x);
    if (Number.isFinite(y)) points.push([x, y]);
  }
  return points;
}
