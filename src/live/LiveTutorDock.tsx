/**
 * LiveTutorDock — the live voice session as a self-contained floating widget.
 *
 * Mounted from App.tsx (like MaterialsPanel), NOT from TutorShell: the shell
 * is under heavy iteration and full-file rewrites there have twice dropped
 * in-column integrations. The dock owns everything the voice feature needs —
 * the session stage, the voice-tutor manager, and its own collapse state — so
 * shell churn can't take it down.
 *
 * Hidden in presenter mode via CSS (body.presenting), which keeps it mounted:
 * a live session's audio keeps playing while the board is full screen.
 */
import { useState } from "react";
import { LiveTutorStage } from "./LiveTutorStage";
import { TutorsPanel } from "../ui/TutorsPanel";

export function LiveTutorDock() {
  const [minimized, setMinimized] = useState(false);
  const [tutorsOpen, setTutorsOpen] = useState(false);
  const [tutorsVersion, setTutorsVersion] = useState(0);

  return (
    <>
      <aside className={`live-dock${minimized ? " live-dock-min" : ""}`} aria-label="Voice tutor">
        <button
          type="button"
          className="live-dock-head"
          onClick={() => setMinimized((m) => !m)}
          title={minimized ? "Open the voice tutor" : "Minimize"}
        >
          <span className="live-dock-dot" aria-hidden />
          Voice tutor
          <span className="live-dock-caret" aria-hidden>
            {minimized ? "▴" : "▾"}
          </span>
        </button>
        {!minimized && (
          <div className="live-dock-body">
            <LiveTutorStage
              refresh={tutorsVersion}
              onManage={() => setTutorsOpen(true)}
            />
          </div>
        )}
      </aside>

      <TutorsPanel
        open={tutorsOpen}
        onClose={() => setTutorsOpen(false)}
        onChanged={() => setTutorsVersion((v) => v + 1)}
      />
    </>
  );
}
