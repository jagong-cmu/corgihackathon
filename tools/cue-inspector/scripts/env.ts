/**
 * Credential loading for the dev server and the replay script.
 *
 * `.env.local` lives at the repo root and is gitignored there. It is read in
 * Node only — the secret never reaches the browser bundle, because the dev
 * server mints tokens itself and hands the client back a JWT plus a URL.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface LiveKitCredentials {
  url: string;
  apiKey: string;
  apiSecret: string;
}

/** Walk up from this file until we find the workspace root. */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "packages"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error("could not locate the repo root from " + import.meta.url);
}

export function envPath(): string {
  return join(repoRoot(), ".env.local");
}

/** Load `.env.local` into process.env. Missing file is not an error here. */
export function loadEnvFile(): boolean {
  const path = envPath();
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}

export class MissingCredentialsError extends Error {}

/**
 * Read LiveKit credentials, or explain precisely what is missing. The tool has
 * a no-credentials path (local replay), so callers are expected to catch this
 * and degrade rather than exit.
 */
export function liveKitCredentials(): LiveKitCredentials {
  const found = loadEnvFile();
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  const missing = [
    ["LIVEKIT_URL", url],
    ["LIVEKIT_API_KEY", apiKey],
    ["LIVEKIT_API_SECRET", apiSecret],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k as string);

  if (missing.length > 0) {
    throw new MissingCredentialsError(
      `${missing.join(", ")} not set. ` +
        (found
          ? `Add them to ${envPath()}.`
          : `Create ${envPath()} (gitignored) with LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.`),
    );
  }

  return { url: url as string, apiKey: apiKey as string, apiSecret: apiSecret as string };
}
