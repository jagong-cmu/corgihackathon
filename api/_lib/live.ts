/**
 * Live tutor session bootstrap (voice + avatar, NOT the whiteboard).
 *
 *   POST /api/live/session { personaId? }  -> { url, token, room, persona }
 *   GET  /api/live/health                  -> { configured }
 *
 * Creates a LiveKit room whose metadata names the persona, then mints a
 * short-lived join token for the learner. The agent worker
 * (apps/agent/src/tutor_agent/adapters/worker.py) reads that same metadata to
 * decide which tutor persona teaches the session, so the browser and the voice
 * agent agree on who is speaking without any extra signaling.
 *
 * Secrets stay in Node: the browser receives a JWT + URL, never the API key
 * (same pattern as tools/cue-inspector). Credentials come from process.env or
 * `.env.local` at the repo root (gitignored).
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";

/** Rooms idle this long with nobody in them are reclaimed by LiveKit. */
const EMPTY_TIMEOUT_S = 300;

// Learner + agent worker + avatar participant + a debug subscriber or two.
const MAX_PARTICIPANTS = 8;

let envLoaded = false;

/**
 * Load `.env.local`, walking up from cwd so a git-worktree checkout still finds
 * the repo root's copy. Existing process.env vars win (loadEnvFile does not
 * override them).
 */
function loadEnvLocal(): void {
  if (envLoaded) return;
  envLoaded = true;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ".env.local");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) return;
    dir = parent;
  }
}

interface LiveKitCredentials {
  url: string;
  apiKey: string;
  apiSecret: string;
}

function credentials(): LiveKitCredentials | null {
  loadEnvLocal();
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) return null;
  return { url, apiKey, apiSecret };
}

export function liveKitConfigured(): boolean {
  return credentials() !== null;
}

export interface LiveSessionRequest {
  personaId?: string;
  /** Reserved for real auth; becomes the owner scope for persona lookup. */
  ownerId?: string;
}

export interface LiveSessionResponse {
  url: string;
  token: string;
  room: string;
  persona: string;
}

const PERSONA_ID = /^[a-z][a-z0-9_-]{1,47}$/; // PersonaSpec.id pattern, verbatim

export async function createLiveSession(
  body: LiveSessionRequest
): Promise<LiveSessionResponse> {
  const creds = credentials();
  if (!creds) {
    throw new Error(
      "LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY and " +
        "LIVEKIT_API_SECRET in .env.local at the repo root."
    );
  }

  const persona = body.personaId ?? "ada";
  if (!PERSONA_ID.test(persona)) {
    throw new Error(`invalid persona id ${JSON.stringify(persona)}`);
  }

  // Room-per-session: a random suffix so two tabs get two tutors instead of
  // overhearing each other.
  const suffix = randomBytes(4).toString("hex");
  const room = `tutor-${persona}-${suffix}`;

  // The REST API lives on the http(s) form of the ws(s) URL.
  const httpUrl = creds.url.replace(/^ws/, "http");
  const svc = new RoomServiceClient(httpUrl, creds.apiKey, creds.apiSecret);
  await svc.createRoom({
    name: room,
    metadata: JSON.stringify({ persona, owner: body.ownerId ?? null }),
    emptyTimeout: EMPTY_TIMEOUT_S,
    maxParticipants: MAX_PARTICIPANTS,
  });

  const at = new AccessToken(creds.apiKey, creds.apiSecret, {
    identity: `learner-${suffix}`,
    ttl: "1h",
  });
  at.addGrant({
    roomJoin: true,
    room,
    canPublish: true, // the learner's microphone
    canSubscribe: true, // the tutor's voice + the avatar's video
    canPublishData: true, // student_event messages, if a client ever sends them
  });

  return { url: creds.url, token: await at.toJwt(), room, persona };
}
