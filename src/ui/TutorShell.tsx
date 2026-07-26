/**
 * TutorShell — the app frame.
 *
 *   - LEFT: the tutor "stage" — an intentional placeholder reserved for the
 *     voice avatar a teammate is building — plus the current spoken line.
 *   - RIGHT: the whiteboard where the visual subsystem draws.
 *
 * Two ways to drive the whiteboard:
 *   - Ask bar: type a question -> POST /api/turn -> live { spokenText,
 *     visualSpec } (falls back to a client mock on a static host).
 *   - Scene switcher: hardcoded specs that exercise each render track.
 */
import { useCallback, useMemo, useRef, useState, type FormEvent } from "react";
import { WhiteboardRenderer } from "../render/WhiteboardRenderer";
import type { RevealApi } from "../voice/voiceInterface";
import {
  functionPlotExample,
  freeformExample,
  brokenExample,
} from "../spec/examples";
import type { VisualSpec } from "../spec/visualSpec";
import { askTutor, type TurnResponse } from "../api";

interface Demo {
  key: string;
  label: string;
  dot: string;
  spokenText: string;
  spec: unknown;
}

const DEMOS: Demo[] = [
  {
    key: "fn",
    label: "Graph a function",
    dot: "#2f5fb0",
    spokenText:
      "Here's the graph of x squared. Watch as I draw the curve, then the tangent at x equals one.",
    spec: functionPlotExample satisfies VisualSpec,
  },
  {
    key: "freeform",
    label: "Explain with Trudy",
    dot: "#e08a3c",
    spokenText:
      "Let me walk you through it — one idea at a time, revealed as I talk.",
    spec: freeformExample satisfies VisualSpec,
  },
  {
    key: "broken",
    label: "Guardrail",
    dot: "#c2413b",
    spokenText:
      "If a drawing ever fails, I fall back to a clean equation — never a blank screen.",
    spec: brokenExample,
  },
];

/** Initial scene from ?demo= so each scene is directly linkable. */
function initialDemoKey(): string {
  if (typeof window === "undefined") return DEMOS[0].key;
  const q = new URLSearchParams(window.location.search).get("demo");
  return DEMOS.some((d) => d.key === q) ? (q as string) : DEMOS[0].key;
}

export function TutorShell() {
  const [demoKey, setDemoKey] = useState<string>(initialDemoKey);
  const [playToken, setPlayToken] = useState(0);
  const revealApiRef = useRef<RevealApi | null>(null);

  const [query, setQuery] = useState("");
  const [live, setLive] = useState<TurnResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const demo = useMemo(
    () => DEMOS.find((d) => d.key === demoKey) ?? DEMOS[0],
    [demoKey]
  );

  const activeSpec: unknown = live ? live.visualSpec : demo.spec;
  const activeSpokenText = live ? live.spokenText : demo.spokenText;

  const onRevealApi = useCallback((api: RevealApi) => {
    revealApiRef.current = api;
  }, []);

  const replay = useCallback(() => setPlayToken((t) => t + 1), []);

  const selectDemo = useCallback((key: string) => {
    setDemoKey(key);
    setLive(null);
    setError(null);
    setPlayToken((t) => t + 1);
  }, []);

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const q = query.trim();
      if (!q || loading) return;
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
    [query, loading]
  );

  return (
    <div className="tutor-shell">
      <header className="tutor-header">
        <div className="brand">
          <BrandMark />
          <div>
            <div className="brand-name">Chalk</div>
            <div className="brand-tag">a tutor that draws while it talks</div>
          </div>
        </div>

        <div className="controls">
          <div className="segmented" role="group" aria-label="Scene">
            {DEMOS.map((d) => (
              <button
                key={d.key}
                type="button"
                className="seg"
                aria-pressed={!live && demoKey === d.key}
                onClick={() => selectDemo(d.key)}
              >
                <span className="seg-dot" style={{ background: d.dot }} />
                {d.label}
              </button>
            ))}
          </div>
          <button className="icon-btn" onClick={replay} title="Replay the animation">
            <ReplayIcon />
            Replay
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
            placeholder="Ask the tutor…  e.g. “graph x^2 and show the tangent at x = 1”"
            onChange={(e) => setQuery(e.target.value)}
            disabled={loading}
          />
        </div>
        <button className="ask-btn" type="submit" disabled={loading || !query.trim()}>
          {loading ? "Thinking…" : "Ask Trudy"}
        </button>
        {live && (
          <span className={`ask-mode ${live.llm ? "live" : "mock"}`}>
            {live.llm ? "live" : "offline demo"}
          </span>
        )}
        {error && <span className="ask-error">⚠ {error}</span>}
      </form>

      <main className="tutor-body">
        {/* LEFT: reserved tutor stage + spoken line */}
        <section className="tutor-col" aria-label="Tutor">
          <div className="tutor-stage">
            <div className="tutor-portrait">
              <div className="tutor-orb">
                <MicIcon />
              </div>
              <div className="tutor-label">Your tutor lives here</div>
              <p className="tutor-sub">
                Reserved for the voice avatar your teammate is building — it speaks
                each line while Trudy draws.
              </p>
              <span className="tutor-chip">Voice · coming soon</span>
            </div>
          </div>

          <div className="narration">
            <div className="narration-label">Now saying</div>
            <p className="narration-text">“{activeSpokenText}”</p>
            <div className="narration-note">
              The voice reads this aloud; the whiteboard reveals in sync.
            </div>
          </div>
        </section>

        {/* RIGHT: the whiteboard */}
        <section className="whiteboard-panel" aria-label="Whiteboard">
          <div className="whiteboard-frame">
            <div className="whiteboard-surface">
              <WhiteboardRenderer
                key={`${live ? "live" : demo.key}-${playToken}`}
                rawSpec={activeSpec}
                autoPlay
                playToken={playToken}
                onRevealApi={onRevealApi}
              />
              <div className="marker-tray" aria-hidden>
                <span className="marker-cap" style={{ background: "#e08a3c" }} />
                <span className="marker-cap" style={{ background: "#2f5fb0" }} />
                <span className="marker-cap" style={{ background: "#c2413b" }} />
              </div>
            </div>
          </div>
        </section>
      </main>
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

function MarkerIcon() {
  return (
    <svg className="marker-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15.5 4.5l4 4L9 19l-5 1 1-5z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0" />
      <path d="M12 17v4" />
    </svg>
  );
}
