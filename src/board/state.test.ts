/**
 * The board reducer, driven by the shared golden fixtures.
 *
 * `packages/canvas-protocol/test/fixtures/*.json` is the integration contract
 * between the two halves of this product: the agent asserts its emitter
 * produces these streams, and this file asserts the canvas renders them. Both
 * sides test against the same artifacts, which is what made it possible to
 * build them independently and have them meet.
 *
 * Replaying a fixture here is not a smoke test. Every fixture is a real lesson
 * shape — a worked problem, a simulation with a barge-in in the middle of it —
 * and the assertions are about what the learner would end up looking at.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeParseAgentMessage, type CanvasAction } from "@tutor/canvas-protocol";
import {
  applyAction,
  emptyBoard,
  findShape,
  tickBoard,
  STEP_REVEAL_MS,
  type BoardState,
} from "./state";

const FIXTURES = join(__dirname, "..", "..", "packages", "canvas-protocol", "test", "fixtures");

interface Fixture {
  name: string;
  messages: Array<Record<string, unknown>>;
}

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Fixture;
}

/**
 * Replay a fixture the way the live client would: validate every frame, drop
 * the ones a cancelled turn kills, and apply the rest at their own cue times.
 */
function replay(name: string, options: { stopAtCancel?: boolean } = {}): BoardState {
  const fixture = loadFixture(name);
  let board = emptyBoard();
  const cancelled = new Set<string>();

  for (const raw of fixture.messages) {
    const message = safeParseAgentMessage(raw);
    if (!message) continue; // student_event: client -> agent, not ours to apply.

    if (message.type === "cancel_turn") {
      cancelled.add(message.turnId);
      if (options.stopAtCancel) break;
      continue;
    }
    if (cancelled.has(message.turnId)) continue;
    board = applyAction(board, message.action, { nowMs: message.cueMs });
  }
  return board;
}

function action(type: string, rest: Record<string, unknown> = {}): CanvasAction {
  return { type, ...rest } as CanvasAction;
}

describe("worked-quadratic fixture", () => {
  const board = replay("worked-quadratic");

  it("puts every shape in the section the turn opened", () => {
    // new_section came first, so nothing belongs in the default section.
    expect(board.sections).toHaveLength(2);
    expect(board.sections[1].title).toBe("Solving x² − 4x + 3 = 0");
    expect(board.sections[0].shapes).toHaveLength(0);
    expect(board.activeSectionIndex).toBe(1);
  });

  it("renders the equation, the steps, and the graph", () => {
    const kinds = board.sections[1].shapes.map((s) => s.kind).sort();
    expect(kinds).toEqual(["equation", "graph", "steps"]);
  });

  it("keeps the sub-line highlight the agent asked for", () => {
    // The agent singles out one line of the factoring steps. Sub-targeting only
    // works because each line is an addressable element rather than a blob of
    // text, which is the reason StepsShape renders per-line.
    const highlighted = Object.entries(board.highlights);
    expect(highlighted).toHaveLength(1);
    const [shapeId, highlight] = highlighted[0];
    expect(shapeId).toBe("steps_factor");
    expect(highlight.sub).toBe("line:2");
  });

  it("pulls the step reveal forward to the line being discussed", () => {
    // The highlight lands at 5980ms, well before the paced reveal would have
    // reached line 2 on its own. The learner must never hear about a line that
    // is not on the board yet.
    const steps = findShape(board, "steps_factor");
    expect(steps?.shape.kind === "steps" && steps.shape.revealed).toBe(3);
  });

  it("leaves the pointer where the agent pointed", () => {
    expect(board.pointer).not.toBeNull();
    expect(board.pointer?.sectionIndex).toBe(1);
  });
});

describe("collision-newton-third fixture", () => {
  it("applies the whole turn when nothing is cancelled", () => {
    const board = replay("collision-newton-third", { stopAtCancel: true });
    const sim = findShape(board, "sim_collision");
    expect(sim?.shape.kind).toBe("sim");
    // Two sim_controls: a slow-motion, then a resume.
    if (sim?.shape.kind === "sim") expect(sim.shape.speed).toBeGreaterThan(0);
  });

  it("drops the cancelled turn's remaining actions but keeps the next turn's", () => {
    const board = replay("collision-newton-third");
    const sim = findShape(board, "sim_collision");
    expect(sim?.shape.kind).toBe("sim");

    // t_0043 lands after the barge-in and must still apply — the learner
    // dragged restitution to 0.3 and the tutor is replaying at the new value.
    // This is the most important turn in the file and the easiest to drop.
    if (sim?.shape.kind === "sim") {
      expect(sim.shape.params.restitution).toBe(0.3);
    }
  });

  it("survives a stream containing a client-to-agent message", () => {
    // The fixture includes a student_event. safeParseAgentMessage returns null
    // rather than throwing, and the replay skips it.
    expect(() => replay("collision-newton-third")).not.toThrow();
  });
});

describe("sections", () => {
  it("starts with a section so a shape can land before new_section is called", () => {
    const board = applyAction(emptyBoard(), action("equation", { id: "e1", x: 10, y: 10, latex: "x" }), {
      nowMs: 0,
    });
    expect(board.sections[0].shapes).toHaveLength(1);
  });

  it("clears a stale arrow when the section changes", () => {
    let board = applyAction(emptyBoard(), action("equation", { id: "e1", x: 10, y: 10, latex: "x" }), { nowMs: 0 });
    board = applyAction(board, action("point_at", { target: "e1", style: "arrow", holdMs: 9000 }), { nowMs: 100 });
    expect(board.pointer).not.toBeNull();

    board = applyAction(board, action("new_section", { title: "Part 2" }), { nowMs: 200 });
    // An arrow left over from the previous page would sit on top of the new
    // one at the same coordinates, pointing at nothing.
    expect(board.pointer).toBeNull();
  });
});

describe("idempotence", () => {
  it("replaces a shape rather than stacking a duplicate on the same id", () => {
    let board = applyAction(emptyBoard(), action("equation", { id: "eq", x: 10, y: 10, latex: "x^2" }), { nowMs: 0 });
    board = applyAction(board, action("equation", { id: "eq", x: 10, y: 10, latex: "x^3" }), { nowMs: 10 });

    expect(board.sections[0].shapes).toHaveLength(1);
    const found = findShape(board, "eq");
    expect(found?.shape.kind === "equation" && found.shape.latex).toBe("x^3");
  });
});

describe("actions that reference nothing", () => {
  // Barge-in can cancel the turn that would have created a shape, so a
  // highlight for a shape that never arrived is normal traffic, not a bug.
  const cases: Array<[string, CanvasAction]> = [
    ["highlight", action("highlight", { target: "ghost", color: "yellow" })],
    ["point_at", action("point_at", { target: "ghost", style: "laser", holdMs: 1000 })],
    ["camera", action("camera", { op: "focus", target: "ghost" })],
    ["sim_control", action("sim_control", { id: "ghost", op: "pause" })],
    ["sim_update", action("sim_update", { id: "ghost", param: "g", value: 1 })],
  ];

  it.each(cases)("%s on an unknown id is a no-op, not a crash", (_name, a) => {
    const board = emptyBoard();
    const next = applyAction(board, a, { nowMs: 0 });
    // Same object: nothing changed and nothing re-renders.
    expect(next).toBe(board);
  });
});

describe("write_steps reveal", () => {
  const steps = action("write_steps", {
    id: "solve",
    x: 40,
    y: 40,
    lines: ["Factor", "Set each to zero", "Solve", "Check"],
    reveal: "one_by_one",
  });

  it("starts with one line visible", () => {
    const board = applyAction(emptyBoard(), steps, { nowMs: 0 });
    const found = findShape(board, "solve");
    expect(found?.shape.kind === "steps" && found.shape.revealed).toBe(1);
  });

  it("advances with playback time, not wall time", () => {
    let board = applyAction(emptyBoard(), steps, { nowMs: 0 });
    board = tickBoard(board, STEP_REVEAL_MS * 2 + 10);
    const found = findShape(board, "solve");
    expect(found?.shape.kind === "steps" && found.shape.revealed).toBe(3);
  });

  it("never advances past the last line", () => {
    let board = applyAction(emptyBoard(), steps, { nowMs: 0 });
    board = tickBoard(board, STEP_REVEAL_MS * 50);
    const found = findShape(board, "solve");
    expect(found?.shape.kind === "steps" && found.shape.revealed).toBe(4);
  });

  it("reveal: all shows everything immediately", () => {
    const board = applyAction(
      emptyBoard(),
      action("write_steps", { id: "s", x: 0, y: 0, lines: ["a", "b", "c"], reveal: "all" }),
      { nowMs: 0 },
    );
    const found = findShape(board, "s");
    expect(found?.shape.kind === "steps" && found.shape.revealed).toBe(3);
  });

  it("a highlight on a later line pulls the reveal forward", () => {
    // Narration running ahead of the pacing is the common case, and a learner
    // hearing about a line that is not on the board yet is the failure.
    let board = applyAction(emptyBoard(), steps, { nowMs: 0 });
    board = applyAction(board, action("highlight", { target: { shapeId: "solve", sub: "line:3" }, color: "yellow" }), {
      nowMs: 50,
    });
    const found = findShape(board, "solve");
    expect(found?.shape.kind === "steps" && found.shape.revealed).toBe(4);
  });
});

describe("pointer expiry", () => {
  it("a laser dot disappears after its hold", () => {
    let board = applyAction(emptyBoard(), action("point_at", { target: { x: 100, y: 100 }, style: "laser", holdMs: 1200 }), { nowMs: 0 });
    expect(board.pointer).not.toBeNull();

    board = tickBoard(board, 1201);
    expect(board.pointer).toBeNull();
  });

  it("an arrow persists past its hold", () => {
    // The protocol draws this distinction explicitly: 'arrow' persists until
    // the section changes.
    let board = applyAction(emptyBoard(), action("point_at", { target: { x: 10, y: 10 }, style: "arrow", holdMs: 500 }), { nowMs: 0 });
    board = tickBoard(board, 5000);
    expect(board.pointer).not.toBeNull();
  });
});

describe("clear_region", () => {
  it("removes shapes inside the rectangle and their highlights", () => {
    let board = emptyBoard();
    board = applyAction(board, action("equation", { id: "inside", x: 100, y: 100, latex: "a" }), { nowMs: 0 });
    board = applyAction(board, action("equation", { id: "outside", x: 600, y: 400, latex: "b" }), { nowMs: 0 });
    board = applyAction(board, action("highlight", { target: "inside", color: "yellow" }), { nowMs: 0 });

    board = applyAction(board, action("clear_region", { bounds: { x: 50, y: 50, w: 200, h: 200 } }), { nowMs: 0 });

    expect(findShape(board, "inside")).toBeNull();
    expect(findShape(board, "outside")).not.toBeNull();
    // A highlight keyed to a shape that no longer exists would leak into the
    // next shape that reuses the id.
    expect(board.highlights.inside).toBeUndefined();
  });
});
