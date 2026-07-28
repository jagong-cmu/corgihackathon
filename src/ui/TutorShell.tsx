/**
 * TutorShell — the app frame.
 *
 *   - LEFT: the active tutor (Trudy by default, or a tutor the user created on
 *     site) — present and speaking the current line aloud.
 *   - RIGHT: the whiteboard where the visual subsystem draws.
 *
 * The UI is generic: you drive the board by ASKING a question — the shared LLM
 * picks the right visual primitive (function plot,
 * vectors, number line, animated diagram, equation, or a freeform scene). The
 * hamburger (top-left) opens the sidebar for sessions, tutors, and materials.
 * "Full screen" drops the board into presenter mode with a tutor face-cam.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { WhiteboardRenderer } from "../render/WhiteboardRenderer";
import { Avatar } from "./Avatar";
import { useTutors } from "../tutors/TutorContext";
import type { RevealApi } from "../voice/voiceInterface";
import type { VisualSpec } from "../spec/visualSpec";
import { subscribeBoardCues } from "../live/boardCueBus";
import { askTutor, type TurnResponse } from "../api";
import { LiveTutorStage } from "../live/LiveTutorStage";
import "./shell.css";

export function TutorShell() {
  const { activeTutor, openSidebar, sessionNonce } = useTutors();

  const [playToken, setPlayToken] = useState(0);
  const revealApiRef = useRef<RevealApi | null>(null);

  const [query, setQuery] = useState("");
  const [live, setLive] = useState<TurnResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // True while the board is driven by the live voice session's cue stream
  // (present_visual / reveal_step) rather than the ask bar. Live-driven specs
  // render with autoPlay off: reveals come from the tutor's narration, and
  // letting the wall-clock mock driver race the audio clock would desync the
  // two on the first hitch.
  const [liveDriven, setLiveDriven] = useState(false);
  // reveal_step cues that arrived before the (re)mounted board handed us its
  // RevealApi — flushed the moment it does.
  const pendingRevealsRef = useRef<string[]>([]);

  // Presenter mode: board fills the screen, the tutor becomes a face-cam bubble.
  const [presenting, setPresenting] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);

  const greeting = `Hi, I'm ${activeTutor.name}. Ask me anything — quick questions, big ideas, or something to walk through on the board.`;
  const activeSpokenText =
    live?.spokenText ||
    (liveDriven ? "Live session — listen in and watch the board." : greeting);

  const onRevealApi = useCallback((api: RevealApi) => {
    revealApiRef.current = api;
    // A live-driven board remounts on present_visual; reveal cues that fired
    // during the mount gap land here.
    const queued = pendingRevealsRef.current;
    pendingRevealsRef.current = [];
    for (const stepId of queued) api.revealStep(stepId);
  }, []);

  // The live voice session (owned by LiveTutorProvider at the App level, so
  // it outlives any shell rerender) fires canvas actions at the moment the
  // tutor's audio reaches their words. Two actions drive this board:
  //   present_visual — a full spec, every step hidden; take over the board.
  //   reveal_step    — draw one step on, in sync with the narration.
  useEffect(() => {
    return subscribeBoardCues((cue) => {
      const action = cue.action;
      if (action.type === "present_visual") {
        // The old board's RevealApi dies with its remount; reveals queue
        // until the new board reports in via onRevealApi.
        revealApiRef.current = null;
        pendingRevealsRef.current = [];
        setLive({
          spokenText: "",
          visualSpec: action.spec as unknown as VisualSpec,
          llm: true,
        });
        setLiveDriven(true);
        setError(null);
        setPlayToken((t) => t + 1);
      } else if (action.type === "reveal_step") {
        const api = revealApiRef.current;
        if (api) api.revealStep(action.stepId);
        else pendingRevealsRef.current.push(action.stepId);
      }
      // Every other action targets the tldraw client — ignore it here.
    });
  }, []);

  const replay = useCallback(() => {
    // A live-driven spec has no cue timeline to replay (its cues already
    // fired off the tutor's audio) — "Replay" completes the drawing instead.
    if (liveDriven) {
      const api = revealApiRef.current;
      if (api && live) for (const step of live.visualSpec.drawSequence) api.revealStep(step.id);
      return;
    }
    setPlayToken((t) => t + 1);
  }, [liveDriven, live]);

  const runQuery = useCallback(
    async (raw: string) => {
      const q = raw.trim();
      if (!q || loading) return;
      setQuery(q);
      setLoading(true);
      setError(null);
      try {
        const res = await askTutor(q);
        setLive(res);
        setLiveDriven(false); // the ask bar re-takes the board with its own timeline
        setPlayToken((t) => t + 1);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [loading]
  );

  const submit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      void runQuery(query);
    },
    [runQuery, query]
  );

  // "New tutoring session" (from the sidebar) clears the conversation.
  useEffect(() => {
    setLive(null);
    setLiveDriven(false);
    pendingRevealsRef.current = [];
    setQuery("");
    setError(null);
    setPlayToken((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionNonce]);

  const enterPresent = useCallback(() => {
    setPresenting(true);
    // Best-effort native fullscreen; the CSS presenter layout stands alone if
    // the browser/iframe denies it, so failures are non-fatal.
    shellRef.current?.requestFullscreen?.().catch(() => {});
  }, []);

  const exitPresent = useCallback(() => {
    setPresenting(false);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }, []);

  // Keep body class in sync (lets floating widgets hide themselves).
  useEffect(() => {
    document.body.classList.toggle("presenting", presenting);
    return () => document.body.classList.remove("presenting");
  }, [presenting]);

  // Esc exits presenter mode; also follow native fullscreen exits (Esc while
  // truly fullscreen doesn't always deliver a keydown to the page).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPresenting(false);
    };
    const onFsChange = () => {
      if (!document.fullscreenElement) setPresenting(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFsChange);
    };
  }, []);

  const voiceLabel = loading ? "Thinking…" : live ? "Speaking aloud" : "Ready to help";

  return (
    <div className={`tutor-shell${presenting ? " presenting" : ""}`} ref={shellRef}>
      <header className="tutor-header">
        <div className="header-left">
          <button className="hamburger" onClick={openSidebar} aria-label="Open menu" title="Menu">
            <span /><span /><span />
          </button>
          <div className="brand">
            <BrandMark />
            <div className="brand-text">
              <div className="brand-name">Chalk</div>
            </div>
          </div>
        </div>

        <div className="controls">
          <button className="icon-btn" onClick={replay} title="Replay the animation">
            <ReplayIcon />
            Replay
          </button>
          <button
            className="icon-btn icon-btn--accent"
            onClick={enterPresent}
            title="Full screen the board (the assistant moves to a face-cam)"
          >
            <ExpandIcon />
            Full screen
          </button>
        </div>
      </header>

      {/* Ask bar: drives the whiteboard from a live turn (mock offline). */}
      <form className="ask-bar" onSubmit={submit}>
        <div className="ask-field">
          <MarkerIcon />
          <input
            className="ask-input"
            type="text"
            value={query}
            placeholder=""
            onChange={(e) => setQuery(e.target.value)}
            disabled={loading}
          />
        </div>
        <button className="ask-btn" type="submit" disabled={loading || !query.trim()}>
          {loading ? "Thinking…" : `Ask ${activeTutor.name}`}
        </button>
        {live && (
          <span className={`ask-mode ${live.llm ? "live" : "mock"}`}>
            {live.llm ? "live" : "offline demo"}
          </span>
        )}
        {error && <span className="ask-error">⚠ {error}</span>}
      </form>

      <main className="tutor-body">
        {/* LEFT: the tutor — one presence. Idle it's the active tutor speaking
            the current line; in a live session the same card becomes the
            session (avatar face, status, mic controls) instead of a second
            box squeezing in underneath. */}
        <section className="tutor-col" aria-label="Tutor">
          <div className="tutor-card">
            <LiveTutorStage idleSpeech={activeSpokenText} idleVoiceLabel={voiceLabel} />
          </div>
          <div className="flex-spacer" aria-hidden />
        </section>

        {/* RIGHT: the whiteboard */}
        <section className="whiteboard-panel" aria-label="Whiteboard">
          <div className="whiteboard-frame">
            <div className="whiteboard-surface">
              {live ? (
                <WhiteboardRenderer
                  key={`live-${playToken}`}
                  rawSpec={live.visualSpec}
                  /* Live-driven boards reveal on the tutor's audio clock via
                     reveal_step cues; the wall-clock mock driver stays off. */
                  autoPlay={!liveDriven}
                  playToken={playToken}
                  onRevealApi={onRevealApi}
                />
              ) : (
                <BoardEmpty tutorName={activeTutor.name} />
              )}
              <div className="marker-tray" aria-hidden>
                <span className="marker-cap" style={{ background: "#e08a3c" }} />
                <span className="marker-cap" style={{ background: "#2f5fb0" }} />
                <span className="marker-cap" style={{ background: "#c2413b" }} />
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Presenter-mode overlay: exit control + tutor face-cam (picture-in-
          picture). Always in the DOM; shown via .presenting. */}
      <button
        className="presenter-exit"
        onClick={exitPresent}
        title="Exit full screen (Esc)"
        aria-label="Exit full screen"
      >
        <CollapseIcon />
        Exit
      </button>

      <aside className="facecam" aria-label="Assistant face-cam">
        <div className="facecam-caption">
          <span className="facecam-live">
            <span className="waveform" aria-hidden>
              <span /><span /><span /><span /><span />
            </span>
            {activeTutor.name}
          </span>
          <span className="facecam-line">{activeSpokenText}</span>
        </div>
        <div className="facecam-bubble">
          <Avatar tutor={activeTutor} size={168} pose="idle" expression="happy" />
        </div>
      </aside>
    </div>
  );
}

/* --------------------------------------------------------------- empty state */

function BoardEmpty({ tutorName }: { tutorName: string }) {
  return (
    <div className="board-empty">
      <div className="board-empty-mark">
        <MarkerIcon />
      </div>
      <h2>A blank whiteboard, ready when you are</h2>
      <p>
        Ask a question above and {tutorName} will explain it right here —
        drawing on the board while talking it through.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ icons */

function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 48 48" role="img" aria-label="Chalk">
      <circle cx="24" cy="24" r="24" fill="#fbf4e8" />
      <path d="M12 16 L8 4 L20 12 Z" fill="#e08a3c" />
      <path d="M36 16 L40 4 L28 12 Z" fill="#e08a3c" />
      <ellipse cx="24" cy="26" rx="16" ry="15" fill="#e6974a" />
      <ellipse cx="18" cy="30" rx="7" ry="7" fill="#fbf4e8" />
      <ellipse cx="30" cy="30" rx="7" ry="7" fill="#fbf4e8" />
      <path d="M24 12 q-4 10 -2 20 q2 4 4 0 q2 -10 -2 -20z" fill="#fbf4e8" />
      <circle cx="19" cy="25" r="2.6" fill="#2c2723" />
      <circle cx="29" cy="25" r="2.6" fill="#2c2723" />
      <path d="M24 30 q-3 4 -6 1 M24 30 q3 4 6 1" fill="none" stroke="#7a5330" strokeWidth="1.6" strokeLinecap="round" />
      <ellipse cx="24" cy="30" rx="2.4" ry="1.8" fill="#2c2723" />
    </svg>
  );
}

function ReplayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v4h4" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8h3a1 1 0 0 0 1-1V4M20 8h-3a1 1 0 0 1-1-1V4M4 16h3a1 1 0 0 1 1 1v3M20 16h-3a1 1 0 0 0-1 1v3" />
    </svg>
  );
}

function MarkerIcon() {
  return (
    <svg className="marker-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15.5 4.5l4 4L9 19l-5 1 1-5z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
  );
}
