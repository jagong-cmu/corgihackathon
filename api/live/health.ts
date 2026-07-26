/** Vercel serverless function: GET /api/live/health — is LiveKit set up here? */
import { liveKitConfigured } from "../_lib/live.js";

interface FnRes {
  status(code: number): FnRes;
  json(body: unknown): void;
}

export default function handler(_req: unknown, res: FnRes): void {
  res.status(200).json({ configured: liveKitConfigured() });
}
