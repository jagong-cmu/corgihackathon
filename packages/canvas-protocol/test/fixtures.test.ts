import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTION_NAMES,
  DataChannelMessage,
  canvasToolDefinitions,
  safeParseAgentMessage,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "fixtures");
const fixtureFiles = readdirSync(fixtureDir).filter((f) => f.endsWith(".json"));

interface Fixture {
  name: string;
  description: string;
  messages: unknown[];
}

const fixtures: Fixture[] = fixtureFiles.map(
  (f) => JSON.parse(readFileSync(join(fixtureDir, f), "utf8")) as Fixture,
);

describe("fixtures", () => {
  it("finds at least one", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    describe(fixture.name, () => {
      it("every message validates", () => {
        for (const [i, message] of fixture.messages.entries()) {
          const result = DataChannelMessage.safeParse(message);
          if (!result.success) {
            throw new Error(
              `${fixture.name}[${i}] failed:\n${JSON.stringify(result.error.issues, null, 2)}`,
            );
          }
        }
      });

      it("seq is monotonic within each turn", () => {
        const seen = new Map<string, number>();
        for (const message of fixture.messages) {
          const parsed = safeParseAgentMessage(message);
          if (parsed?.type !== "canvas_action") continue;
          const previous = seen.get(parsed.turnId);
          if (previous !== undefined) {
            expect(parsed.seq).toBeGreaterThan(previous);
          }
          seen.set(parsed.turnId, parsed.seq);
        }
      });

      it("cueMs is non-decreasing within each turn", () => {
        const seen = new Map<string, number>();
        for (const message of fixture.messages) {
          const parsed = safeParseAgentMessage(message);
          if (parsed?.type !== "canvas_action") continue;
          const previous = seen.get(parsed.turnId) ?? 0;
          expect(parsed.cueMs).toBeGreaterThanOrEqual(previous);
          seen.set(parsed.turnId, parsed.cueMs);
        }
      });

      it("references only ids created earlier in the stream", () => {
        const created = new Set<string>();
        for (const message of fixture.messages) {
          const parsed = safeParseAgentMessage(message);
          if (parsed?.type !== "canvas_action") continue;
          const action = parsed.action;

          if ("id" in action && typeof action.id === "string") {
            // Creation actions declare a new id; control actions reuse one.
            if (action.type === "sim_control" || action.type === "sim_update") {
              expect(created, `${action.type} references unknown id ${action.id}`).toContain(
                action.id,
              );
            } else {
              created.add(action.id);
            }
          }
        }
      });
    });
  }
});

describe("tool definitions", () => {
  const tools = canvasToolDefinitions();

  it("emits one tool per registered action", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...ACTION_NAMES].sort());
  });

  it("every tool is strict with a closed object schema", () => {
    for (const tool of tools) {
      expect(tool.strict, tool.name).toBe(true);
      expect(tool.input_schema.type, tool.name).toBe("object");
      expect(tool.input_schema.additionalProperties, tool.name).toBe(false);
    }
  });

  it("every tool description says when to call it", () => {
    for (const tool of tools) {
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
    }
  });
});

describe("malformed input", () => {
  it("returns null rather than throwing", () => {
    expect(safeParseAgentMessage({ type: "canvas_action", turnId: "nope" })).toBeNull();
    expect(safeParseAgentMessage(null)).toBeNull();
    expect(safeParseAgentMessage("garbage")).toBeNull();
  });

  it("rejects an unknown action type", () => {
    expect(
      safeParseAgentMessage({
        type: "canvas_action",
        turnId: "t_0001",
        seq: 0,
        cueMs: 0,
        action: { type: "summon_demon", x: 0, y: 0 },
      }),
    ).toBeNull();
  });

  it("rejects sim_control speed without a value", () => {
    expect(
      safeParseAgentMessage({
        type: "canvas_action",
        turnId: "t_0001",
        seq: 0,
        cueMs: 0,
        action: { type: "sim_control", id: "sim_x", op: "speed" },
      }),
    ).toBeNull();
  });
});
