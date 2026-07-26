/**
 * The validation boundary.
 *
 * Every inbound frame — from the data channel or from a replayed fixture —
 * goes through here, and nothing unvalidated reaches the cue queue (§13:
 * "no unvalidated JSON ever reaches the tldraw editor").
 *
 * The schemas come from @tutor/canvas-protocol. They are not redefined here
 * and must never be: that package is the single source of truth, and a second
 * copy of the message shape in a debug tool is how you end up debugging the
 * debugger.
 *
 * The product client drops invalid frames *silently* and logs them. This tool
 * does the opposite by design — it exists to make the drops loud.
 */

import {
  safeParseAgentMessage,
  safeParseClientMessage,
  type AgentMessage,
  type ClientMessage,
} from "@tutor/canvas-protocol";

export type FrameResult =
  /** A valid agent -> client frame. The only kind that reaches the cue queue. */
  | { kind: "agent"; message: AgentMessage; raw: unknown }
  /** Valid, but client -> agent (student_event, client_hello). Not ours. */
  | { kind: "client"; message: ClientMessage; raw: unknown }
  /** Failed schema validation, or wasn't JSON at all. */
  | { kind: "invalid"; reason: string; text: string };

const decoder = new TextDecoder();

export function classifyBytes(payload: Uint8Array): FrameResult {
  let text: string;
  try {
    text = decoder.decode(payload);
  } catch (err) {
    return { kind: "invalid", reason: `undecodable bytes: ${describe(err)}`, text: "<binary>" };
  }
  return classifyText(text);
}

export function classifyText(text: string): FrameResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { kind: "invalid", reason: `not JSON: ${describe(err)}`, text: truncate(text) };
  }
  return classifyValue(parsed, text);
}

export function classifyValue(value: unknown, text?: string): FrameResult {
  const agent = safeParseAgentMessage(value);
  if (agent) return { kind: "agent", message: agent, raw: value };

  // Not an agent frame. Before calling it malformed, check whether it is a
  // well-formed message travelling the other way — the fixtures interleave
  // student_events, and reporting those as corruption would be a false alarm.
  const client = safeParseClientMessage(value);
  if (client) return { kind: "client", message: client, raw: value };

  return {
    kind: "invalid",
    reason: describeShape(value),
    text: truncate(text ?? safeStringify(value)),
  };
}

function describeShape(value: unknown): string {
  if (value === null) return "expected an object, got null";
  if (typeof value !== "object") return `expected an object, got ${typeof value}`;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string") return "missing a string `type` discriminator";
  const known = ["canvas_action", "cancel_turn", "student_event", "client_hello"];
  if (!known.includes(type)) return `unknown message type ${JSON.stringify(type)}`;
  return `failed ${type} schema validation`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max = 160): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
