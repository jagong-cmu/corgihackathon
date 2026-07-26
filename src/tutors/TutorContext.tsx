/**
 * TutorContext — the app's small in-memory store.
 *
 * Holds the roster of tutors (a built-in "Trudy" plus any the user creates on
 * site from a photo + a voice recording), which tutor is active, and the UI
 * state for the sidebar / create-tutor modal / "new session" reset signal.
 *
 * Everything is in memory only (no localStorage, per the project guardrails).
 * Custom tutors keep their photo as a data URL and their voice sample as an
 * object URL so they survive re-renders within the session.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface Tutor {
  id: string;
  name: string;
  /** persona = lives in the persona API (can speak in live voice sessions). */
  kind: "builtin" | "custom" | "persona";
  /** Custom tutors: a captured/uploaded photo as a data URL.
   *  Persona tutors: their avatar photo URL, when the avatar_ref has one. */
  photo?: string;
  /** Custom tutors: a recorded/uploaded voice sample as an object URL. */
  voiceUrl?: string;
  /** Accent color used in avatars/among the roster. */
  accent?: string;
  /** PersonaSpec.id when this tutor is backed by the persona API — the id a
   * live voice session starts with. */
  personaId?: string;
  /** Persona tutors: whether a voice is assigned (sessions need one). */
  hasVoice?: boolean;
}

/** The built-in corgi tutor. Rendered from the hand-built SVG rig. */
export const TRUDY: Tutor = {
  id: "trudy",
  name: "Trudy",
  kind: "builtin",
  accent: "#e0873a",
};

export interface NewTutorInput {
  name: string;
  photo?: string;
  voiceUrl?: string;
  accent?: string;
  personaId?: string;
  hasVoice?: boolean;
}

/** What syncPersonas needs to know about each persona (see tutorApi.toOption). */
export interface PersonaRosterEntry {
  id: string;
  name: string;
  hasVoice: boolean;
  photoUrl: string | null;
}

interface TutorContextValue {
  tutors: Tutor[];
  activeTutor: Tutor;
  setActiveTutor: (id: string) => void;
  addTutor: (input: NewTutorInput) => Tutor;
  removeTutor: (id: string) => void;
  /** Reconcile the roster's persona-backed entries with the persona API. */
  syncPersonas: (personas: PersonaRosterEntry[]) => void;

  // UI state
  sidebarOpen: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;

  createOpen: boolean;
  openCreate: () => void;
  closeCreate: () => void;

  /** The voice-tutor manager panel (TutorsPanel). */
  manageOpen: boolean;
  openManage: () => void;
  closeManage: () => void;

  /** Bumps whenever personas change server-side, so lists re-fetch. */
  personasVersion: number;
  personasChanged: () => void;

  /** Bumps on "new tutoring session" so the shell can reset its conversation. */
  sessionNonce: number;
  newSession: () => void;
}

const Ctx = createContext<TutorContextValue | null>(null);

function makeId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  }
}

const ACCENTS = ["#2f5fb0", "#c2413b", "#5f7d59", "#7a58b5", "#c98a1e"];

export function TutorProvider({ children }: { children: ReactNode }) {
  const [tutors, setTutors] = useState<Tutor[]>([TRUDY]);
  const [activeTutorId, setActiveTutorId] = useState<string>(TRUDY.id);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [personasVersion, setPersonasVersion] = useState(0);
  const [sessionNonce, setSessionNonce] = useState(0);

  const activeTutor = useMemo(
    () => tutors.find((t) => t.id === activeTutorId) ?? TRUDY,
    [tutors, activeTutorId]
  );

  const addTutor = useCallback((input: NewTutorInput): Tutor => {
    const tutor: Tutor = {
      id: makeId(),
      name: input.name.trim() || "New tutor",
      kind: "custom",
      photo: input.photo,
      voiceUrl: input.voiceUrl,
      accent: input.accent ?? ACCENTS[Math.floor(Math.random() * ACCENTS.length)],
      personaId: input.personaId,
      hasVoice: input.hasVoice,
    };
    setTutors((prev) => [...prev, tutor]);
    setActiveTutorId(tutor.id);
    return tutor;
  }, []);

  const syncPersonas = useCallback((personas: PersonaRosterEntry[]) => {
    setTutors((prev) => {
      // Locals keep their spot; persona-kind entries are replaced wholesale.
      // A local tutor already backed by one of these personas (created by the
      // modal) claims it, so the roster doesn't show the same person twice.
      const locals = prev.filter((t) => t.kind !== "persona");
      const claimed = new Set(locals.map((t) => t.personaId).filter(Boolean));
      const accentFor = (id: string) =>
        ACCENTS[Math.abs([...id].reduce((h, c) => h * 31 + c.charCodeAt(0), 7)) % ACCENTS.length];
      const synced: Tutor[] = personas
        .filter((p) => !claimed.has(p.id))
        .map((p) => ({
          id: p.id,
          name: p.name,
          kind: "persona",
          photo: p.photoUrl ?? undefined,
          accent: accentFor(p.id),
          personaId: p.id,
          hasVoice: p.hasVoice,
        }));
      return [...locals, ...synced];
    });
    // An active persona tutor that vanished server-side falls back to Trudy
    // via the activeTutor ?? TRUDY memo — no need to touch activeTutorId here.
  }, []);

  const removeTutor = useCallback(
    (id: string) => {
      if (id === TRUDY.id) return; // never remove the built-in
      setTutors((prev) => prev.filter((t) => t.id !== id));
      setActiveTutorId((cur) => (cur === id ? TRUDY.id : cur));
    },
    []
  );

  const value: TutorContextValue = {
    tutors,
    activeTutor,
    setActiveTutor: setActiveTutorId,
    addTutor,
    removeTutor,
    syncPersonas,
    sidebarOpen,
    openSidebar: useCallback(() => setSidebarOpen(true), []),
    closeSidebar: useCallback(() => setSidebarOpen(false), []),
    createOpen,
    openCreate: useCallback(() => setCreateOpen(true), []),
    closeCreate: useCallback(() => setCreateOpen(false), []),
    manageOpen,
    openManage: useCallback(() => setManageOpen(true), []),
    closeManage: useCallback(() => setManageOpen(false), []),
    personasVersion,
    personasChanged: useCallback(() => setPersonasVersion((v) => v + 1), []),
    sessionNonce,
    newSession: useCallback(() => setSessionNonce((n) => n + 1), []),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTutors(): TutorContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTutors must be used within <TutorProvider>");
  return v;
}
