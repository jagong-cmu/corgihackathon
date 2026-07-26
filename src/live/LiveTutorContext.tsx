/**
 * LiveTutorContext — owns the live voice session for the whole app.
 *
 * Mounted in App above the shell (where the floating dock used to live) so a
 * session survives any amount of shell churn: the audio elements hang off
 * document.body, cue delivery goes through boardCueBus, and this provider owns
 * the LiveKit room. What moved into the shell is only the *rendering* of the
 * tutor's presence (TutorShell's card), which reads everything from here.
 *
 * Also the one place tutor options are fetched (persona API → deployed
 * serverless list → built-ins) and mirrored into the TutorContext roster, so
 * the sidebar, the card, and the session picker all agree on who exists.
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useLiveTutor, type LiveTutorApi } from "./useLiveTutor";
import { publishBoardCue } from "./boardCueBus";
import { useTutors } from "../tutors/TutorContext";
import {
  BUILTIN_TUTORS,
  listDeployedTutors,
  listTutors,
  toOption,
  tutorApiAvailable,
  type TutorOption,
} from "../tutorApi";

interface LiveTutorContextValue {
  live: LiveTutorApi;
  /** Startable tutors (personas), freshest source available. */
  options: TutorOption[];
  /** Whether LiveKit is configured on this host; null while checking. */
  configured: boolean | null;
}

const Ctx = createContext<LiveTutorContextValue | null>(null);

export function LiveTutorProvider({ children }: { children: ReactNode }) {
  const live = useLiveTutor(publishBoardCue);
  const { personasVersion, syncPersonas } = useTutors();
  const [options, setOptions] = useState<TutorOption[]>(BUILTIN_TUTORS);
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/live/health")
      .then((r) => r.json())
      .then((b) => !cancelled && setConfigured(Boolean(b.configured)))
      .catch(() => !cancelled && setConfigured(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Tutor options, best source first: the persona API (full local stack),
  // then the deployed /api/live/tutors list (serverless), built-ins as floor.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let next = BUILTIN_TUTORS;
      if (await tutorApiAvailable()) {
        try {
          const fromApi = (await listTutors()).map(toOption);
          if (fromApi.length) {
            const seen = new Set(fromApi.map((t) => t.id));
            next = [...fromApi, ...BUILTIN_TUTORS.filter((t) => !seen.has(t.id))];
          }
        } catch {
          /* API up but listing failed (e.g. DB down) — try the next tier */
        }
      }
      if (next === BUILTIN_TUTORS) {
        const deployed = await listDeployedTutors();
        if (deployed) next = deployed;
      }
      if (cancelled) return;
      setOptions(next);
      syncPersonas(
        next.map((t) => ({ id: t.id, name: t.name, hasVoice: t.hasVoice, photoUrl: t.photoUrl }))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [personasVersion, syncPersonas]);

  return <Ctx.Provider value={{ live, options, configured }}>{children}</Ctx.Provider>;
}

export function useLiveTutorContext(): LiveTutorContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLiveTutorContext must be used within <LiveTutorProvider>");
  return v;
}
