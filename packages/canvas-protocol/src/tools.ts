import { z } from "zod";
import { ACTION_REGISTRY, type ActionName } from "./actions.js";

/**
 * Claude tool definitions derived from the action registry.
 *
 * One tool per action, so the model calls `write_steps(...)` rather than
 * emitting a tagged blob. Tool inputs stream incrementally when
 * eager_input_streaming is set, which is what lets the worker map a tool call's
 * position in the text stream to a word index and then to a TTS timestamp.
 *
 * Canvas actions are fire-and-forget: the worker returns a stub tool_result
 * immediately so the turn never blocks on the client. This is the opposite of
 * Merge Agent Handler calls, which leave our infrastructure and must be
 * narration-covered (§7.3).
 */
export interface ClaudeToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Anthropic strict tool use — guarantees input validates against the schema. */
  strict: boolean;
  /** Streams tool input token-by-token so the worker can time cues precisely. */
  eager_input_streaming: true;
}

export interface ToolOptions {
  /** Restrict to a subset of actions. Defaults to all of them. */
  only?: readonly ActionName[];
  /**
   * UNVERIFIED: several actions have optional properties (`reveal`, `holdMs`,
   * `region`), which are absent from `required` in the generated schema. If
   * strict tool use rejects schemas whose `required` omits any property, these
   * will 400 — flip this to false and re-run the spike. Confirm on the first
   * real API call before building on it.
   */
  strict?: boolean;
}

function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >;
}

/** Build tool definitions for the given actions, or all of them by default. */
export function canvasToolDefinitions(options: ToolOptions = {}): ClaudeToolDefinition[] {
  const { only, strict = true } = options;
  const names = (only ?? (Object.keys(ACTION_REGISTRY) as ActionName[])) as ActionName[];
  return names.map((name) => {
    const entry = ACTION_REGISTRY[name];
    return {
      name,
      description: entry.description,
      input_schema: toInputSchema(entry.params),
      strict,
      eager_input_streaming: true,
    };
  });
}

/**
 * JSON Schema for every action, keyed by name. Exported to disk for the Python
 * worker so both sides validate against the same definitions (§12).
 */
export function actionJsonSchemas(): Record<string, unknown> {
  return Object.fromEntries(
    (Object.keys(ACTION_REGISTRY) as ActionName[]).map((name) => [
      name,
      toInputSchema(ACTION_REGISTRY[name].params),
    ]),
  );
}
