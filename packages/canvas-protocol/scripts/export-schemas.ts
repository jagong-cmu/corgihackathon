/**
 * Exports JSON Schema for every action plus the data-channel envelopes, so the
 * Python agent worker validates against the same definitions the TypeScript
 * client does (§12: canvas-protocol is the single source of truth).
 *
 *   npm run export-schemas -w @tutor/canvas-protocol
 *
 * Output lands in schemas/ (NOT dist/) and is committed, so the Python side can
 * read it without running the TypeScript build. Regenerate and commit whenever
 * an action changes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AgentMessage,
  CanvasAction,
  ClientMessage,
  PROTOCOL_VERSION,
  actionJsonSchemas,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "schemas");
mkdirSync(outDir, { recursive: true });

const bundle = {
  $comment: `Generated from @tutor/canvas-protocol. Do not edit by hand.`,
  protocolVersion: PROTOCOL_VERSION,
  actions: actionJsonSchemas(),
  canvasAction: z.toJSONSchema(CanvasAction, { target: "draft-2020-12", io: "input" }),
  agentMessage: z.toJSONSchema(AgentMessage, { target: "draft-2020-12", io: "input" }),
  clientMessage: z.toJSONSchema(ClientMessage, { target: "draft-2020-12", io: "input" }),
};

const outPath = join(outDir, "canvas-protocol.json");
writeFileSync(outPath, `${JSON.stringify(bundle, null, 2)}\n`);
console.log(`wrote ${outPath}`);
