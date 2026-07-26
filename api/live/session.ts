/**
 * Vercel serverless function: POST /api/live/session
 *
 * The deployed twin of the vite-dev middleware in server/vitePlugin.ts — same
 * path, same body, same response — so the frontend needs no environment
 * switch. All the real logic lives in server/live.ts; this file is transport.
 *
 * Requires LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET in the Vercel
 * project's environment variables.
 */
import { createLiveSession, liveKitConfigured } from "../../server/live";

interface FnReq {
  method?: string;
  body?: unknown;
}
interface FnRes {
  status(code: number): FnRes;
  json(body: unknown): void;
}

export default async function handler(req: FnReq, res: FnRes): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  if (!liveKitConfigured()) {
    res.status(503).json({
      error:
        "LiveKit is not configured on this deployment. Set LIVEKIT_URL, " +
        "LIVEKIT_API_KEY and LIVEKIT_API_SECRET in the project's environment.",
    });
    return;
  }
  try {
    const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as {
      personaId?: string;
      ownerId?: string;
    };
    res.status(200).json(await createLiveSession(body));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
}
