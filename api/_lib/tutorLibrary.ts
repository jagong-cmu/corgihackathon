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

const DEFAULT_LIVE_TUTORS: LiveTutorOption[] = [
  // Curated YAML personas the worker always has:
  { id: "ada", name: "Ada", hasVoice: true, avatarProvider: "lemonslice" },
  { id: "coach-rios", name: "Coach Rios", hasVoice: true, avatarProvider: "lemonslice" },
  // Custom tutors that live in the demo team's persona store:
  { id: "nico", name: "Nico", hasVoice: true, avatarProvider: "lemonslice" },
];

export function liveTutorLibrary(): LiveTutorOption[] {
  const raw = process.env.TUTOR_LIBRARY;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every(isOption)) return parsed;
      console.warn("TUTOR_LIBRARY is not an array of tutor options — using the default list");
    } catch {
      console.warn("TUTOR_LIBRARY is not valid JSON — using the default list");
    }
  }
  return DEFAULT_LIVE_TUTORS;
}

function isOption(x: unknown): x is LiveTutorOption {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as LiveTutorOption).id === "string" &&
    typeof (x as LiveTutorOption).name === "string"
  );
}
