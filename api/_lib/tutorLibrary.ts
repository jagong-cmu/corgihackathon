/**
 * The tutor list served to deployed clients (no persona API/Postgres online).
 *
 * On a full local stack the picker lists personas straight from apps/api;
 * this is the fallback tier for serverless deployments: which personas the
 * *worker* can load is what matters, and the worker resolves them from its own
 * Postgres/YAML — this list only has to name them for the picker.
 *
 * Override without a code change by setting TUTOR_LIBRARY to a JSON array of
 * {id, name, hasVoice, avatarProvider} (e.g. in the Vercel dashboard).
 */

export interface LiveTutorOption {
  id: string;
  name: string;
  hasVoice: boolean;
  avatarProvider: string;
}

// Keep in sync with BUILTIN_TUTORS in src/tutorApi.ts (client-side floor).
const DEFAULT_LIVE_TUTORS: LiveTutorOption[] = [
  // Curated YAML personas the worker always has:
  { id: "ada", name: "Ada", hasVoice: true, avatarProvider: "lemonslice" },
  { id: "coach-rios", name: "Coach Rios", hasVoice: true, avatarProvider: "lemonslice" },
  // Store-canonical tutors from the demo team's persona store (each also
  // ships a curated YAML fallback, so the worker can resolve them in a DB
  // outage):
  { id: "nico", name: "Nico", hasVoice: true, avatarProvider: "lemonslice" },
  { id: "aayush", name: "Aayush", hasVoice: true, avatarProvider: "lemonslice" },
];

export function liveTutorLibrary(): LiveTutorOption[] {
  const raw = process.env.TUTOR_LIBRARY;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every(isOption)) return parsed.map(toOption);
      console.warn("TUTOR_LIBRARY is not an array of tutor options — using the default list");
    } catch {
      console.warn("TUTOR_LIBRARY is not valid JSON — using the default list");
    }
  }
  return DEFAULT_LIVE_TUTORS;
}

function isOption(x: unknown): x is { id: string; name: string } {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as { id?: unknown }).id === "string" &&
    typeof (x as { name?: unknown }).name === "string"
  );
}

/** Only id + name are required of operator JSON; the rest defaults safely
 * (hasVoice: false keeps Start disabled instead of ringing a voiceless tutor).
 * Building a fresh object drops any extra fields, so nothing an operator puts
 * in the env var reaches anonymous clients verbatim. */
function toOption(x: { id: string; name: string } & Record<string, unknown>): LiveTutorOption {
  return {
    id: x.id,
    name: x.name,
    hasVoice: typeof x.hasVoice === "boolean" ? x.hasVoice : false,
    avatarProvider: typeof x.avatarProvider === "string" ? x.avatarProvider : "none",
  };
}
