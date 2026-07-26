/**
 * The expression evaluator.
 *
 * Function strings in a `GraphSpec` are written by a model, which makes them
 * untrusted input that ends up inside a `Function` constructor. The security
 * cases below are the reason this file exists; the arithmetic cases are there
 * so a tightened whitelist cannot silently break real plots.
 */

import { describe, expect, it } from "vitest";
import { compileFn, derivativeAt, samplePoints, ExpressionError } from "./mathfn";

describe("compileFn", () => {
  it("evaluates plain arithmetic", () => {
    expect(compileFn("x^2")(3)).toBe(9);
    expect(compileFn("x^2 - 4*x + 3")(1)).toBe(0);
    expect(compileFn("2*x + 1")(2.5)).toBe(6);
  });

  it("supports the Math library bare", () => {
    expect(compileFn("sin(0)")(0)).toBe(0);
    expect(compileFn("sqrt(x)")(16)).toBe(4);
    expect(compileFn("abs(x)")(-3)).toBe(3);
    expect(compileFn("PI")(0)).toBeCloseTo(Math.PI);
  });

  it("binds declared parameters", () => {
    const fn = compileFn("a*x^2 + b", { a: 2, b: 1 });
    expect(fn(3)).toBe(19);
  });

  it("re-compiles to a different curve when a parameter changes", () => {
    // This is what makes the slider meaningful: same expression, new value.
    expect(compileFn("a*x", { a: 1 })(5)).toBe(5);
    expect(compileFn("a*x", { a: -2 })(5)).toBe(-10);
  });

  describe("rejects", () => {
    const unsafe = [
      ["a bare global", "window"],
      ["property access", "x.constructor"],
      ["a function call", "alert(1)"],
      ["a constructor escape", "constructor"],
      ["template literals", "`${x}`"],
      ["assignment", "x = 1"],
      ["a semicolon-separated statement", "x; fetch('/')"],
      ["an undeclared identifier", "a*x"],
      ["an empty expression", "   "],
    ];

    it.each(unsafe)("%s", (_label, expression) => {
      expect(() => compileFn(expression)).toThrow(ExpressionError);
    });

    it("a parameter name that shadows a built-in", () => {
      // Binding `sin` as a parameter would let a spec redefine the Math call
      // the same expression makes.
      expect(() => compileFn("sin(x)", { sin: 1 })).toThrow(ExpressionError);
      expect(() => compileFn("x", { x: 1 })).toThrow(ExpressionError);
    });

    it("a parameter name that is not a plain identifier", () => {
      expect(() => compileFn("x", { "a); return fetch('/'); (": 1 })).toThrow(ExpressionError);
    });
  });

  it("allows an expression that is NaN at a point", () => {
    // log(0) is -Infinity and sqrt(-1) is NaN; both are legitimate curves with
    // a hole in them, not malformed specs.
    const fn = compileFn("sqrt(x)");
    expect(Number.isNaN(fn(-1))).toBe(true);
    expect(fn(4)).toBe(2);
  });
});

describe("derivativeAt", () => {
  it("matches the analytic derivative closely enough to draw", () => {
    expect(derivativeAt(compileFn("x^2"), 1)).toBeCloseTo(2, 4);
    expect(derivativeAt(compileFn("x^3"), 2)).toBeCloseTo(12, 3);
    expect(derivativeAt(compileFn("sin(x)"), 0)).toBeCloseTo(1, 4);
  });
});

describe("samplePoints", () => {
  it("returns points across the range", () => {
    const points = samplePoints(compileFn("x"), 0, 10, 10);
    expect(points).toHaveLength(11);
    expect(points[0]).toEqual([0, 0]);
    expect(points[10]).toEqual([10, 10]);
  });

  it("drops points where the function is undefined", () => {
    // One NaN vertex makes an SVG polygon render as nothing at all, so a
    // shaded region under sqrt would silently vanish instead of clipping.
    const points = samplePoints(compileFn("sqrt(x)"), -5, 5, 10);
    expect(points.every(([, y]) => Number.isFinite(y))).toBe(true);
    expect(points.length).toBeLessThan(11);
  });
});
