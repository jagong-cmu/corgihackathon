/**
 * TutorShell — the TEST harness UI (not the final product).
 *
 * Layout matches the product vision:
 *   - LEFT: the "person" panel — a placeholder. The voice teammate owns the
 *     real avatar; we just reserve the space and show narration/cues here.
 *   - RIGHT: the whiteboard "learning terminal" where the visual subsystem
 *     draws.
 *
 * The controls (spec picker + Replay) exist only to exercise the renderer.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { WhiteboardRenderer } from "../render/WhiteboardRenderer";
import type { RevealApi } from "../voice/voiceInterface";
import {
  functionPlotExample,
  freeformExample,
  brokenExample,
} from "../spec/examples";
import type { VisualSpec } from "../spec/visualSpec";

interface Demo {
  key: string;
  label: string;
  spokenText: string;
  spec: unknown;
}

/**
 * Developer test scenes. These are NOT product features — they exist only to
 * exercise the renderer (deterministic track, freeform track, fallback). The
 * real product drives the renderer from live LLM-emitted specs (Phase 2+).
 */
const DEMOS: Demo[] = [
  {
    key: "fn",
    label: "Deterministic · function plot + tangent",
    spokenText:
      "Here's the graph of x squared. Watch as I draw the curve, then the tangent at x equals one.",
    spec: functionPlotExample satisfies VisualSpec,
  },
  {
    key: "freeform",
    label: "Freeform · animated mascot (placeholder rig)",
    spokenText:
      "This is the freeform track: an animated guide reveals an explanation one step at a time.",
    spec: freeformExample satisfies VisualSpec,
  },
  {
    key: "broken",
    label: "Fallback · invalid spec → equation",
    spokenText:
      "This spec is intentionally broken — the renderer should fall back to an equation, not a blank screen.",
    spec: brokenExample,
  },
];

/** Initial scene from ?demo= so each test scene is directly linkable. */
function initialDemoKey(): string {
  if (typeof window === "undefined") return DEMOS[0].key;
  const q = new URLSearchParams(window.location.search).get("demo");
  return DEMOS.some((d) => d.key === q) ? (q as string) : DEMOS[0].key;
}

export function TutorShell() {
  const [demoKey, setDemoKey] = useState<string>(initialDemoKey);
  const [playToken, setPlayToken] = useState(0);
  const revealApiRef = useRef<RevealApi | null>(null);

  const demo = useMemo(
    () => DEMOS.find((d) => d.key === demoKey) ?? DEMOS[0],
    [demoKey]
  );

  const onRevealApi = useCallback((api: RevealApi) => {
    revealApiRef.current = api;
  }, []);

  const replay = useCallback(() => setPlayToken((t) => t + 1), []);

  const selectDemo = useCallback((key: string) => {
    setDemoKey(key);
    setPlayToken((t) => t + 1);
  }, []);

  return (
    <div className="tutor-shell">
      <header className="tutor-header">
        <div className="brand">Whiteboard <span>· AI tutor visual subsystem</span></div>
        <div className="controls">
          <label className="control-label">Test scene:</label>
          <select
            value={demoKey}
            onChange={(e) => selectDemo(e.target.value)}
            className="demo-select"
          >
            {DEMOS.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </select>
          <button className="replay-btn" onClick={replay}>
            ▶ Replay
          </button>
        </div>
      </header>

      <main className="tutor-body">
        {/* LEFT: person placeholder (voice teammate owns the real avatar) */}
        <section className="person-panel" aria-label="Tutor (voice) — placeholder">
          <div className="person-placeholder">
            <div className="person-avatar">🧑‍🏫</div>
            <div className="person-caption">Voice tutor</div>
            <div className="person-sub">(owned by voice teammate)</div>
          </div>
          <div className="narration">
            <div className="narration-label">Narration (spokenText)</div>
            <p className="narration-text">{demo.spokenText}</p>
            <div className="narration-note">
              TTS reads this immediately; visuals reveal async via syncCues.
            </div>
          </div>
        </section>

        {/* RIGHT: the whiteboard learning terminal */}
        <section className="whiteboard-panel" aria-label="Whiteboard">
          <div className="whiteboard-frame">
            <WhiteboardRenderer
              key={`${demo.key}-${playToken}`}
              rawSpec={demo.spec}
              autoPlay
              playToken={playToken}
              onRevealApi={onRevealApi}
            />
          </div>
        </section>
      </main>
    </div>
  );
}
