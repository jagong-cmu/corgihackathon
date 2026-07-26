import { z } from "zod/v4";
import { CanvasAction } from "./actions.js";
import { PROTOCOL_VERSION, ShapeId } from "./common.js";

/**
 * Data-channel message format (§4).
 *
 * Ordering rules the client enforces:
 *   - actions within a turn apply in `seq` order regardless of arrival order
 *   - a new turn's first action implicitly cancels any unfired cues from the
 *     previous turn (this is how barge-in works)
 *   - invalid actions are dropped silently and logged to event_log; a missing
 *     arrow is invisible, a crashed canvas ends the lesson
 */

export const TurnId = z.string().regex(/^t_\d{4,}$/, "turn ids look like t_0142");

// ---------------------------------------------------------------------------
// Agent -> client
// ---------------------------------------------------------------------------

export const CanvasActionMessage = z.strictObject({
  type: z.literal("canvas_action"),
  v: z.literal(PROTOCOL_VERSION).optional(),
  turnId: TurnId,
  seq: z.number().int().nonnegative().describe("Ordering within the turn."),
  cueMs: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Offset into this turn's audio at which to apply the action. 0 fires immediately. Derived from the TTS character timestamps of the words this action belongs to.",
    ),
  action: CanvasAction,
});

/**
 * Sent when a turn is abandoned mid-flight (barge-in, error, hangup). The
 * client drops every unfired cue for that turn. The next turn's first action
 * does this implicitly, but an explicit cancel closes the gap when the next
 * turn is slow to start.
 */
export const CancelTurnMessage = z.strictObject({
  type: z.literal("cancel_turn"),
  turnId: TurnId,
  reason: z.enum(["barge_in", "error", "session_end"]),
});

export const AgentMessage = z.discriminatedUnion("type", [
  CanvasActionMessage,
  CancelTurnMessage,
]);

// ---------------------------------------------------------------------------
// Client -> agent
// ---------------------------------------------------------------------------

/**
 * Student activity, sent between turns and folded into the next turn's context
 * (§5.3). Deictic references ("why is THIS negative?") resolve via shapeIds.
 */
export const StudentEventMessage = z.strictObject({
  type: z.literal("student_event"),
  kind: z.enum(["drew", "selected", "moved", "sim_param_changed", "dropped_image"]),
  shapeIds: z.array(ShapeId).max(64).default([]),
  detail: z.record(z.string(), z.unknown()).default({}),
  /** Set when the event is visual and the agent should request a screenshot. */
  needsScreenshot: z.boolean().default(false),
});

/**
 * Sent once on join so the agent knows what the client can render. A client on
 * an older protocol gets a reduced action set rather than silent drops.
 */
export const ClientHelloMessage = z.strictObject({
  type: z.literal("client_hello"),
  protocolVersion: z.string(),
  supportedActions: z.array(z.string()),
});

export const ClientMessage = z.discriminatedUnion("type", [
  StudentEventMessage,
  ClientHelloMessage,
]);

// ---------------------------------------------------------------------------

export const DataChannelMessage = z.union([AgentMessage, ClientMessage]);

export type CanvasActionMessage = z.infer<typeof CanvasActionMessage>;
export type CancelTurnMessage = z.infer<typeof CancelTurnMessage>;
export type AgentMessage = z.infer<typeof AgentMessage>;
export type StudentEventMessage = z.infer<typeof StudentEventMessage>;
export type ClientHelloMessage = z.infer<typeof ClientHelloMessage>;
export type ClientMessage = z.infer<typeof ClientMessage>;
export type DataChannelMessage = z.infer<typeof DataChannelMessage>;

/**
 * Parse an inbound data-channel frame. Returns null instead of throwing —
 * callers on the render path must never crash on a malformed action (§13).
 */
export function safeParseAgentMessage(raw: unknown): AgentMessage | null {
  const result = AgentMessage.safeParse(raw);
  return result.success ? result.data : null;
}

export function safeParseClientMessage(raw: unknown): ClientMessage | null {
  const result = ClientMessage.safeParse(raw);
  return result.success ? result.data : null;
}
