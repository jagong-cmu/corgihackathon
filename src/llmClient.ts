/**
 * Client-side LLM turn — makes the app a real "chatbot with visuals" even with
 * NO backend (e.g. the static GitHub Pages build).
 *
 * When /api/turn isn't reachable, api.ts calls this. If an Anthropic key is
 * available it asks Claude directly from the browser (same system prompt the
 * server uses) and returns a validated VisualSpec; otherwise the caller falls
 * back to the keyword mock.
 *
 * KEY HANDLING — the key stays in THE USER'S browser, never in the repo or the
 * built bundle:
 *   - open the app once with ?ai_key=sk-ant-... (it's saved to localStorage and
 *     stripped from the URL), OR
 *   - set localStorage["chalk_ai_key"] yourself.
 * This is meant for a demo with a key you rotate afterward. For a permanent,
 * secure setup, run the backend (server/turn.ts) with the key server-side.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { TurnResponse } from "./api";
import { SYSTEM_PROMPT, buildUserPrompt } from "../server/prompt";
import { validateVisualSpec } from "./spec/validate";
import { matchDemoTurn } from "./spec/demoScenes";

const KEY_STORAGE = "chalk_ai_key";
// Fast + high quality for a live demo; the server default is opus.
const CLIENT_MODEL = "claude-sonnet-4-6";

/** Read the key from a one-time URL param (persisted) or localStorage. */
export function getAiKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get("ai_key");
    if (fromUrl) {
      localStorage.setItem(KEY_STORAGE, fromUrl);
      url.searchParams.delete("ai_key");
      window.history.replaceState({}, "", url.toString());
      return fromUrl;
    }
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

export function hasAiKey(): boolean {
  return !!getAiKey();
}

/** Strip markdown fences / stray prose and parse the first JSON object. */
function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

/**
 * Ask Claude directly from the browser and return a validated turn. Throws on
 * any failure (no key, network, invalid spec) so the caller can fall back to
 * the keyword mock.
 */
export async function clientAiTurn(userQuery: string): Promise<TurnResponse> {
  // Our two demo questions stay deterministic even in AI mode.
  const demo = matchDemoTurn(userQuery);
  if (demo) return { ...demo, llm: false };

  const apiKey = getAiKey();
  if (!apiKey) throw new Error("no client AI key");

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const msg = await client.messages.create({
    model: CLIENT_MODEL,
    max_tokens: 1600,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserPrompt(userQuery) }],
  });

  const text = msg.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();

  const parsed = extractJson(text) as { spokenText?: unknown; visualSpec?: unknown };
  const result = validateVisualSpec(parsed.visualSpec);
  if (!result.ok) throw new Error(`invalid spec: ${result.error}`);

  return {
    spokenText:
      typeof parsed.spokenText === "string" && parsed.spokenText
        ? parsed.spokenText
        : "Here's what I can show you.",
    visualSpec: result.spec,
    llm: true,
  };
}
