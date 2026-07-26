/**
 * The validation boundary.
 *
 * Every inbound data-channel frame passes through here and nothing else in the
 * app parses one. Schemas are never redefined locally: `safeParseAgentMessage`
 * from `@tutor/canvas-protocol` is the only way a frame gets in, so a protocol
 * change breaks this file rather than silently changing what the board renders.
 *
 * §13: invalid actions are dropped and counted, never thrown. A missing arrow
 * is invisible; an exception on the render path ends the lesson.
 */

import { safeParseAgentMessage, type AgentMessage } from "@tutor/canvas-protocol";

export interface FrameStats {
  accepted: number;
  dropped: number;
  /** Last few rejection reasons, for the debug panel. */
  recentDrops: string[];
}

const MAX_RECENT_DROPS = 8;

export class FrameGate {
  readonly stats: FrameStats = { accepted: 0, dropped: 0, recentDrops: [] };

  /** Bytes off the wire to a validated message, or null. */
  parse(payload: Uint8Array): AgentMessage | null {
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      this.drop("frame was not valid JSON");
      return null;
    }

    const message = safeParseAgentMessage(raw);
    if (!message) {
      // Deliberately not the zod error: it is long, and the actionable part is
      // which action type failed.
      const type =
        raw && typeof raw === "object" && "type" in raw ? String((raw as any).type) : "unknown";
      const action =
        raw && typeof raw === "object" && "action" in raw
          ? String((raw as any).action?.type ?? "?")
          : "";
      this.drop(`rejected ${type}${action ? ` (${action})` : ""}`);
      return null;
    }

    this.stats.accepted += 1;
    return message;
  }

  private drop(reason: string): void {
    this.stats.dropped += 1;
    this.stats.recentDrops = [reason, ...this.stats.recentDrops].slice(0, MAX_RECENT_DROPS);
    console.warn("[canvas] dropped a frame:", reason);
  }
}
