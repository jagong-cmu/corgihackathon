/**
 * Term splitting.
 *
 * `highlight` with `sub: "term:3"` is only meaningful if term 3 is the same
 * thing the agent counted when it chose that number. The agent counts terms the
 * way a person reads them — separated by top-level `+`, `-`, and `=` — so that
 * is what this has to reproduce.
 */

import { describe, expect, it } from "vitest";
import { splitTerms } from "./EquationShape";

const texts = (latex: string) => splitTerms(latex).map((t) => t.tex);

describe("splitTerms", () => {
  it("splits a polynomial the way it reads", () => {
    expect(texts("x^2 - 4x + 3 = 0")).toEqual(["x^2", "4x", "3", "0"]);
  });

  it("keeps the operator that preceded each term", () => {
    expect(splitTerms("a + b = c").map((t) => t.op)).toEqual([null, "+", "="]);
  });

  it("does not split inside a fraction", () => {
    // The `+` here belongs to the numerator. Splitting on it would make
    // "term:1" mean something different to each side.
    expect(texts("\\frac{a+b}{c} = d")).toEqual(["\\frac{a+b}{c}", "d"]);
  });

  it("does not split inside a subscript or superscript group", () => {
    expect(texts("\\vec{F}_{AB} = -\\vec{F}_{BA}")).toEqual([
      "\\vec{F}_{AB}",
      "-\\vec{F}_{BA}",
    ]);
  });

  it("treats a leading minus as a sign, not a separator", () => {
    expect(texts("-x + 1")).toEqual(["-x", "1"]);
  });

  it("treats a minus after another operator as a sign", () => {
    expect(texts("a = -b")).toEqual(["a", "-b"]);
  });

  it("does not cut a backslash command in half", () => {
    // `\leq` contains no operator, but a naive character scan splitting on
    // its letters would produce garbage LaTeX that KaTeX renders as an error.
    expect(texts("x \\leq y")).toEqual(["x \\leq y"]);
  });

  it("returns the whole equation when there is nothing to split", () => {
    expect(texts("\\frac{d}{dx}")).toEqual(["\\frac{d}{dx}"]);
  });

  it("never returns an empty list", () => {
    expect(splitTerms("")).toHaveLength(1);
  });
});
