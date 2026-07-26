/**
 * TutorShell — the app frame.
 *
 *   - LEFT: the active tutor (Trudy by default, or a tutor the user created on
 *     site) — present and speaking the current line aloud.
 *   - RIGHT: the whiteboard where the visual subsystem draws.
 *
 * The UI is generic: you drive the board by ASKING (typed question or a starter
 * prompt) — the shared LLM picks the right visual primitive (function plot,
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
import { askTutor, type TurnResponse } from "../api";
import "./shell.css";

/**
 * Generic, subject-agnostic starter prompts. These aren't hardcoded scenes —
 * each is sent through the normal Ask path, so the LLM chooses the primitive.
 * They double as the demo: the first three reproduce the math/vector/interval
 * visuals, the last two exercise animated + freeform explanations.
 */
const STARTERS = [
  "Graph x² and show the tangent at x = 1",
  "Add the vectors a = (3, 1) and b = (1, 3)",
  "Show the interval −1 < x ≤ 3 on a number line",
  "Explain Newton's second law",
  "Explain recursion in simple terms",
];

export function TutorShell() {
  const { activeTutor, openSidebar, sessionNonce } = useTutors();

  const [playToken, setPlayToken] = useState(0);
  const revealApiRef = useRef<RevealApi | null>(null);

  const [query, setQuery] = useState("");
  const [live, setLive] = useState<TurnResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Presenter mode: board fills the screen, the tutor becomes a face-cam bubble.
  const [presenting, setPresenting] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);

  const greeting = `Hi, I'm ${activeTutor.name}. Ask me anything — I'll explain it on the board while I talk.`;
  const activeSpokenText = live ? live.spokenText : greeting;

  const onRevealApi = useCallback((api: RevealApi) => {
    revealApiRef.current = api;
  }, []);

  const replay = useCallback(() => setPlayToken((t) => t + 1), []);

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

  const voiceLabel = loading ? "Thinking…" : live ? "Speaking aloud" : "Ready to teach";

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
              <div className="brand-tag">a tutor that draws while it talks</div>
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
            title="Full screen the board (the tutor moves to a face-cam)"
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
            placeholder="Ask the tutor anything…  e.g. “graph x^2 and show the tangent at x = 1”"
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

      {/* Generic starter prompts (until the first question). */}
      {!live && (
        <div className="starter-row">
          <span className="starter-label">Try</span>
          {STARTERS.map((s) => (
            <button
              key={s}
              type="button"
              className="starter-chip"
              onClick={() => void runQuery(s)}
              disabled={loading}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <main className="tutor-body">
        {/* LEFT: the active tutor — present, speaking the current line aloud. */}
        <section className="tutor-col" aria-label="Tutor">
          <div className="tutor-card">
            <div className="tutor-avatar">
              <Avatar tutor={activeTutor} size={168} pose="idle" expression="happy" />
            </div>
            <div className="tutor-id">
              <div className="tutor-name">{activeTutor.name}</div>
              <div className="tutor-role">Your tutor</div>
            </div>
            <span className="voice-status">
              <span className="waveform" aria-hidden>
                <span /><span /><span /><span /><span />
              </span>
              {voiceLabel}
            </span>

            <div className="speech">
              <div className="speech-label">
                <span className="dot" aria-hidden /> Now saying
              </div>
              <p className="speech-text">
                <span className="q">“</span>
                {activeSpokenText}
                <span className="q">”</span>
              </p>
            </div>
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
                  autoPlay
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

      <aside className="facecam" aria-label="Tutor face-cam">
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
        Ask a question above, or pick a starter. {tutorName} will explain it right
        here — drawing on the board while talking it through.
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
