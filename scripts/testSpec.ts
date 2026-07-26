/**
 * Internal feedback loop: exercise the spec contract + math evaluator WITHOUT a
 * browser. Run with `npm run test:spec`. Non-zero exit on any failure.
 *
 * This is the "test each function before shipping" guardrail in code form.
 */
import { validateVisualSpec } from "../src/spec/validate";
import {
  functionPlotExample,
  freeformExample,
  brokenExample,
} from "../src/spec/examples";
import { compileFn, derivativeAt } from "../src/render/mathfn";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`[${status}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// 1. Valid function_plot passes.
{
  const r = validateVisualSpec(functionPlotExample);
  check("valid function_plot validates", r.ok, r.ok ? "" : r.error);
}

// 2. Valid freeform_scene passes.
{
  const r = validateVisualSpec(freeformExample);
  check("valid freeform_scene validates", r.ok, r.ok ? "" : r.error);
}

// 3. Broken spec (missing domain) is rejected -> triggers fallback.
{
  const r = validateVisualSpec(brokenExample);
  check("broken spec is rejected", !r.ok, r.ok ? "unexpectedly valid" : r.error);
}

// 4. Unknown primitive is rejected at the envelope.
{
  const r = validateVisualSpec({
    specVersion: 1,
    track: "deterministic",
    primitive: "quantum_hologram",
    content: {},
    drawSequence: [],
  });
  check("unknown primitive is rejected", !r.ok);
}

// 5. Wrong specVersion is rejected (versioned contract).
{
  const r = validateVisualSpec({ ...functionPlotExample, specVersion: 2 });
  check("wrong specVersion is rejected", !r.ok);
}

// 6. Math evaluator: x^2 at 3 = 9; derivative at 1 ≈ 2.
{
  const f = compileFn("x^2");
  check("compileFn x^2 at 3 = 9", Math.abs(f(3) - 9) < 1e-9, `got ${f(3)}`);
  const d = derivativeAt(f, 1);
  check("d/dx x^2 at 1 ≈ 2", Math.abs(d - 2) < 1e-3, `got ${d.toFixed(4)}`);
}

// 7. Math evaluator supports functions: sin(0) = 0.
{
  const f = compileFn("sin(x)");
  check("compileFn sin(0) = 0", Math.abs(f(0)) < 1e-9);
}

// 8. Malicious expression is rejected (no arbitrary code exec).
{
  let threw = false;
  try {
    compileFn("window.alert(1)");
  } catch {
    threw = true;
  }
  check("unsafe expression is rejected", threw);
}

console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} FAILURE(S) ❌`}`);
process.exit(failures === 0 ? 0 : 1);
