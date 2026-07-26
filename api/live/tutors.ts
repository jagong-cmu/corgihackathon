/**
 * Vercel serverless function: GET /api/live/tutors — tutors for the session
 * picker on deployments where the persona API isn't reachable. See
 * server/tutorLibrary.ts for the list and the TUTOR_LIBRARY override.
 */
import { liveTutorLibrary } from "../_lib/tutorLibrary.js";

interface FnRes {
  status(code: number): FnRes;
  json(body: unknown): void;
}

export default function handler(_req: unknown, res: FnRes): void {
  res.status(200).json({ tutors: liveTutorLibrary() });
}
