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

/** What the sidebar roster and tutor card need, whether or not the API is up. */
export interface TutorOption {
  id: string;
  name: string;
  hasVoice: boolean;
  avatarProvider: string;
  /** Displayable photo for this tutor, when the avatar_ref resolves to one. */
  photoUrl: string | null;
}

/**
 * The client's no-backend floor: shown when neither tutor API tier is
 * reachable. All three ship as worker YAML (nico.yaml is the curated fallback
 * for the persona-store row), so they can connect even without the database.
 * Keep in sync with DEFAULT_LIVE_TUTORS in api/_lib/tutorLibrary.ts.
 */
export const BUILTIN_TUTORS: TutorOption[] = [
  // Nico is the home page's default tutor (TutorContext DEFAULT_PERSONA_ID) —
  // if it's missing from this floor list, a persona-API outage leaves the
  // default seat empty and the Start button dead.
  { id: "nico", name: "Nico", hasVoice: true, avatarProvider: "lemonslice", photoUrl: "/tutors/nico.jpg" },
  { id: "ada", name: "Ada", hasVoice: true, avatarProvider: "lemonslice", photoUrl: null },
  { id: "coach-rios", name: "Coach Rios", hasVoice: true, avatarProvider: "lemonslice", photoUrl: null },
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

/**
 * A displayable URL for a persona's avatar_ref, when it points at a photo:
 * `blob:<id>` refs are served by the API (through the dev proxy), http(s)
 * refs are used as-is, and provider-side ids (LemonSlice agent / Simli face)
 * have no photo we can show.
 */
export function avatarPhotoUrl(ref: string | null | undefined): string | null {
  if (!ref) return null;
  if (ref.startsWith("blob:")) return `${BASE}/blobs/${ref.slice("blob:".length)}`;
  if (ref.startsWith("http://") || ref.startsWith("https://")) return ref;
  return null;
}

/**
 * Bundled portraits for tutors whose avatar_ref is a provider-side id (a
 * LemonSlice agent) rather than a photo the API can serve. They are the same
 * photos the avatars were built from, committed under public/tutors/ so the
 * roster shows a face on every tier — including the no-backend BUILTIN floor
 * and the deployed /api/live/tutors list, neither of which can resolve a
 * provider id to an image.
 */
export const BUNDLED_TUTOR_PHOTOS: Record<string, string> = {
  nico: "/tutors/nico.jpg",
  aayush: "/tutors/aayush.jpg",
};

/** Fill photoUrl from the bundled portraits when a tier couldn't provide one. */
export function withBundledPhoto(option: TutorOption): TutorOption {
  if (option.photoUrl) return option;
  const bundled = BUNDLED_TUTOR_PHOTOS[option.id];
  return bundled ? { ...option, photoUrl: bundled } : option;
}

export function toOption(spec: TutorSpec): TutorOption {
  return withBundledPhoto({
    id: spec.id,
    name: spec.identity.name,
    hasVoice: Boolean(spec.voice?.voice_id),
    avatarProvider: spec.avatar?.provider ?? "none",
    photoUrl:
      (spec.avatar?.provider ?? "none") === "none" ? null : avatarPhotoUrl(spec.avatar?.avatar_ref),
  });
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
    if (!Array.isArray(body?.tutors) || !body.tutors.length) return null;
    // The deployed list has no photoUrl field at all — normalize it in, then
    // fill from the bundled portraits.
    return body.tutors.map((t: TutorOption) =>
      withBundledPhoto({ ...t, photoUrl: t.photoUrl ?? null })
    );
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
/**
 * Vercel serverless functions reject request bodies over ~4.5MB at the
 * platform level (a bare 413 that never reaches our code), and a WAV of a
 * minute already exceeds that. Instant cloning only uses 1-2 minutes of
 * speech, so anything oversized is decoded and re-encoded down to mono
 * 22.05kHz WAV capped at 80s — always comfortably under the limit.
 */
const MAX_UPLOAD_BYTES = 3_500_000;
const CLONE_SAMPLE_RATE = 22_050;
const CLONE_MAX_SECONDS = 80;

async function shrinkAudioForUpload(file: File): Promise<File> {
  if (file.size <= MAX_UPLOAD_BYTES) return file;
  try {
    const decoder = new AudioContext();
    const decoded = await decoder.decodeAudioData(await file.arrayBuffer());
    void decoder.close();
    const seconds = Math.min(decoded.duration, CLONE_MAX_SECONDS);
    const offline = new OfflineAudioContext(
      1,
      Math.ceil(seconds * CLONE_SAMPLE_RATE),
      CLONE_SAMPLE_RATE
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return new File([wavBytes(rendered)], file.name.replace(/\.[^.]*$/, "") + ".wav", {
      type: "audio/wav",
    });
  } catch {
    // Undecodable in this browser — send as-is and let the server answer.
    return file;
  }
}

/** Minimal RIFF/PCM16 encoder for a mono AudioBuffer. */
function wavBytes(buffer: AudioBuffer): ArrayBuffer {
  const samples = buffer.getChannelData(0);
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return view.buffer;
}

export async function cloneVoice(slug: string, file: File): Promise<{ voice_id: string }> {
  const form = new FormData();
  form.append("file", await shrinkAudioForUpload(file));
  return request<{ voice_id: string; cloned: boolean }>(`/personas/${slug}/voice`, {
    method: "POST",
    body: form,
  });
}

// ------------------------------------------------- create from a capture

/** Attach a photo to a tutor. Stored in the API's blob store; the agent worker
 * hands the bytes to LemonSlice at session start, so no public URL is needed. */
export async function uploadAvatarPhoto(
  slug: string,
  file: File
): Promise<{ blob_id: string; avatar_ref: string }> {
  const form = new FormData();
  form.append("file", file);
  return request(`/personas/${slug}/avatar`, { method: "POST", body: form });
}

/** What the create-tutor modal captures. */
export interface CapturedTutor {
  name: string;
  /** Webcam snapshot or uploaded picture, as a data URL. */
  photoDataUrl?: string | null;
  /** Recorded/uploaded voice sample, as an object URL. */
  voiceUrl?: string | null;
}

export interface CreatedFromCapture {
  /** The persona as the API now serves it — null when the API isn't running. */
  spec: TutorSpec | null;
  /** Anything that didn't work end-to-end, in words the user can act on. */
  warnings: string[];
}

function dataUrlToFile(dataUrl: string, baseName: string): File {
  const [head, body] = dataUrl.split(",", 2);
  const mime = head.match(/^data:([^;]+)/)?.[1] ?? "image/jpeg";
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ext = mime.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
  return new File([bytes], `${baseName}.${ext}`, { type: mime });
}

const AUDIO_EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

async function objectUrlToAudioFile(url: string, baseName: string): Promise<File> {
  const blob = await (await fetch(url)).blob();
  // MediaRecorder reports e.g. "audio/webm;codecs=opus"; the API matches on
  // the bare mime type.
  const mime = (blob.type || "audio/webm").split(";")[0];
  return new File([blob], `${baseName}.${AUDIO_EXT[mime] ?? "webm"}`, { type: mime });
}

/** A slug for the new tutor that doesn't silently replace an existing one. */
async function freeSlug(name: string): Promise<string | null> {
  const base = slugify(name);
  if (!base) return null;
  const taken = new Set((await listTutors()).map((t) => t.id));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base.slice(0, 45)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

/**
 * The whole modal flow in one call: create a synthetic persona, clone the
 * captured voice on ElevenLabs, attach the photo for the LemonSlice avatar.
 *
 * Best-effort by design — a failed clone (no key, plan-gated) or a rejected
 * photo leaves a usable persona plus a warning saying what to finish in the
 * Tutors panel, and an unreachable API returns spec:null so the caller can
 * keep the tutor local to this session.
 */
export async function createTutorFromCapture(
  input: CapturedTutor,
  onProgress?: (message: string) => void
): Promise<CreatedFromCapture> {
  const warnings: string[] = [];
  onProgress?.("Reaching the persona API…");
  if (!(await tutorApiAvailable())) {
    return {
      spec: null,
      warnings: [
        "The persona API isn't running (see LIVE_TUTOR.md), so this assistant lives only in this browser session — it can't speak in live sessions.",
      ],
    };
  }

  const slug = await freeSlug(input.name);
  if (!slug) {
    return {
      spec: null,
      warnings: ["Couldn't derive an id from that name — start it with a letter."],
    };
  }

  onProgress?.("Creating the assistant…");
  await createTutor({
    id: slug,
    kind: "synthetic",
    identity: { name: input.name.trim(), relationship: "the user's personal voice assistant" },
    speech: {
      catchphrases: [],
      fillers: [],
      verbosity: "medium",
      warmth: "high",
      formality: "low",
    },
    pedagogy: {
      style: "direct",
      patience: "high",
      on_wrong_answer: "asks what led them there before correcting",
      analogy_sources: [],
    },
    few_shot: [],
    never_does: ["says “Great question!”"],
    voice: null, // cloned below when a sample was captured
    // Provider first, photo second: the upload endpoint fills avatar_ref.
    avatar: { provider: input.photoDataUrl ? "lemonslice" : "none", avatar_ref: null },
  });

  if (input.photoDataUrl) {
    onProgress?.("Attaching the photo (their face for LemonSlice)…");
    try {
      await uploadAvatarPhoto(slug, dataUrlToFile(input.photoDataUrl, slug));
    } catch (err) {
      warnings.push(`The photo didn't take (${(err as Error).message}) — sessions run voice-only.`);
    }
  }

  if (input.voiceUrl) {
    onProgress?.("Cloning the voice on ElevenLabs…");
    try {
      await cloneVoice(slug, await objectUrlToAudioFile(input.voiceUrl, `${slug}-voice`));
    } catch (err) {
      const message =
        (err as Error).message === "413"
          ? "the sample is too large for the server — trim it to under ~2 minutes"
          : (err as Error).message;
      warnings.push(
        `Voice cloning failed (${message}) — assign a voice in the Tutors panel; sessions need one.`
      );
    }
  } else {
    warnings.push("No voice sample — assign a voice in the Tutors panel before starting a session.");
  }

  try {
    const spec = await request<TutorSpec>(`/personas/${slug}`);
    return { spec, warnings };
  } catch {
    return { spec: null, warnings: [...warnings, "Created, but reading the tutor back failed."] };
  }
}
