/**
 * Client for the persona/voice/avatar API (apps/api, FastAPI), reached through
 * the same-origin `/tutor-api` dev proxy (see vite.config.ts). Everything here
 * degrades gracefully: when the API or its database isn't running, the app
 * still works with the built-in YAML personas — you just can't author new ones.
 *
 * This file is about WHO the tutor is. The live voice session (LiveKit room,
 * audio, avatar video) is src/live/useLiveTutor.ts.
 */

export interface TutorIdentity {
  name: string;
  relationship: string;
  bio?: string | null;
}

export interface TutorExchange {
  student: string;
  tutor: string;
  note?: string | null;
}

export interface TutorVoice {
  provider: string;
  voice_id: string;
  model?: string;
  stability?: number;
  similarity_boost?: number;
}

export interface TutorAvatar {
  provider: string;
  avatar_ref?: string | null;
}

/** Mirrors PersonaSpec (apps/agent .../persona/spec.py) as FastAPI serves it. */
export interface TutorSpec {
  id: string;
  kind: "synthetic" | "self" | "real_person";
  identity: TutorIdentity;
  speech: {
    catchphrases: string[];
    fillers: string[];
    verbosity: "terse" | "medium" | "expansive";
    warmth: "low" | "medium" | "high";
    formality: "low" | "medium" | "high";
    humor?: string | null;
    address_as?: string | null;
  };
  pedagogy: {
    style: "socratic" | "direct" | "worked_example" | "story";
    patience: "low" | "medium" | "high";
    on_wrong_answer: string;
    analogy_sources: string[];
    encouragement?: string | null;
  };
  few_shot: TutorExchange[];
  never_does: string[];
  voice?: TutorVoice | null;
  avatar: TutorAvatar;
}

/** What the session picker needs, whether or not the API is up. */
export interface TutorOption {
  id: string;
  name: string;
  hasVoice: boolean;
  avatarProvider: string;
}

/**
 * The curated YAML personas the agent worker always has, even with no
 * database. Shown when the persona API is unreachable.
 */
export const BUILTIN_TUTORS: TutorOption[] = [
  { id: "ada", name: "Ada", hasVoice: true, avatarProvider: "lemonslice" },
  { id: "coach-rios", name: "Coach Rios", hasVoice: true, avatarProvider: "simli" },
];

const BASE = "/tutor-api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {
      /* non-JSON error body; the status code will have to do */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

/** True when apps/api answers on the proxy. */
export async function tutorApiAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`);
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return body?.status === "ok";
  } catch {
    return false;
  }
}

/** Library personas (ownerless). Custom tutors created by the UI live here. */
export async function listTutors(): Promise<TutorSpec[]> {
  const body = await request<{ personas: TutorSpec[] }>("/personas");
  return body.personas;
}

export function toOption(spec: TutorSpec): TutorOption {
  return {
    id: spec.id,
    name: spec.identity.name,
    hasVoice: Boolean(spec.voice?.voice_id),
    avatarProvider: spec.avatar?.provider ?? "none",
  };
}

/**
 * PersonaSpec.id pattern, verbatim. Derived from the display name so the form
 * doesn't need a separate slug field.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 48);
  return /^[a-z][a-z0-9_-]{1,47}$/.test(slug) ? slug : "";
}

/**
 * Create (or replace) a tutor. The UI authors `synthetic` tutors only: they're
 * the one kind the schema allows in the ownerless library (migration 0005
 * requires an owner for `self`/`real_person`, and there's no auth yet).
 */
export async function createTutor(spec: TutorSpec): Promise<TutorSpec> {
  return request<TutorSpec>("/personas", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(spec),
  });
}

/** Partial update — merged and re-validated server-side. */
export async function patchTutor(
  slug: string,
  patch: Partial<TutorSpec>
): Promise<TutorSpec> {
  return request<TutorSpec>(`/personas/${slug}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function deleteTutor(slug: string): Promise<void> {
  const res = await fetch(`${BASE}/personas/${slug}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error(`delete failed (${res.status})`);
}

// ---------------------------------------------------------------- voices

export interface VoiceOption {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  preview_url?: string | null;
}

export interface VoiceCapabilities {
  tier: string;
  can_clone_instant: boolean;
  can_clone_professional: boolean;
  voice_limit: number;
  voices_used: number;
  slots_remaining: number;
}

/**
 * Deployed-tier tutor list (a serverless function / dev middleware at
 * /api/live/tutors). Used when the full persona API isn't reachable —
 * e.g. the Vercel deployment. Returns null when unavailable or empty.
 */
export async function listDeployedTutors(): Promise<TutorOption[] | null> {
  try {
    const res = await fetch("/api/live/tutors");
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body?.tutors) && body.tutors.length ? body.tutors : null;
  } catch {
    return null;
  }
}

/** The ElevenLabs voice library — usable on any plan, including free. */
export async function listVoices(): Promise<VoiceOption[]> {
  const body = await request<{ voices: VoiceOption[] }>("/voices");
  return body.voices;
}

/** Ask before offering cloning in the UI — it's plan-gated. */
export async function voiceCapabilities(): Promise<VoiceCapabilities> {
  return request<VoiceCapabilities>("/voices/capabilities");
}

/** Assign a library voice to a tutor. */
export async function assignVoice(slug: string, voiceId: string): Promise<void> {
  await request(`/personas/${slug}/voice?voice_id=${encodeURIComponent(voiceId)}`, {
    method: "POST",
  });
}

/** Clone a voice from an uploaded sample (1-2 min of clear speech). */
export async function cloneVoice(slug: string, file: File): Promise<{ voice_id: string }> {
  const form = new FormData();
  form.append("file", file);
  return request<{ voice_id: string; cloned: boolean }>(`/personas/${slug}/voice`, {
    method: "POST",
    body: form,
  });
}
