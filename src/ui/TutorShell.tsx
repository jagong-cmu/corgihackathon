/**
 * TutorShell — the app frame for a live lesson.
 *
 *   - LEFT: the tutor. The avatar's video when the persona has one, Trudy
 *     otherwise, plus the controls that matter during a lesson: talk, mute,
 *     leave.
 *   - RIGHT: the whiteboard, filled in by the agent's action stream.
 *
 * There is no text input. The learner talks; the agent transcribes, thinks,
 * speaks, and draws. Every visual on the board arrived as a `canvas_action`
 * timed to the words it belongs to — nothing here polls, and nothing here asks
 * a model for anything.
 */

import { useEffect, useRef } from "react";
import type { RemoteVideoTrack } from "livekit-client";
import { Board } from "../board/Board";
import { Trudy } from "../mascot/Trudy";
import type { LiveSessionApi } from "../live/useLiveSession";

interface Props {
  session: LiveSessionApi;
}

const STATUS_LABELS: Record<string, string> = {
  idle: "not connected",
  connecting: "connecting",
  "waiting-for-tutor": "waiting for the tutor",
  live: "live",
  reconnecting: "reconnecting",
  error: "error",
};

export function TutorShell({ session }: Props) {
  const {
    board,
    status,
    detail,
    error,
    info,
    avatarTrack,
    audioBlocked,
    micEnabled,
    drift,
    log,
    connect,
    disconnect,
    toggleMic,
    enableAudio,
    setParameter,
    selectShape,
    userId,
  } = session;

  const connected = status !== "idle" && status !== "error";
  const worstDrift = drift.length ? drift[0] : null;

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
          <span className={`status-pill is-${status}`}>
            <span className="status-dot" />
            {STATUS_LABELS[status] ?? status}
            {info && status === "live" && <em>· {info.persona}</em>}
          </span>

          {connected ? (
            <>
              <button
                className={`icon-btn${micEnabled ? "" : " is-muted"}`}
                onClick={() => void toggleMic()}
                title={micEnabled ? "Mute your microphone" : "Unmute your microphone"}
              >
                <MicIcon muted={!micEnabled} />
                {micEnabled ? "Mic on" : "Muted"}
              </button>
              <button className="icon-btn is-danger" onClick={() => void disconnect()}>
                Leave
              </button>
            </>
          ) : (
            <button className="ask-btn" onClick={() => void connect()}>
              Start a lesson
            </button>
          )}
        </div>
      </header>

      {audioBlocked && (
        // Without playback there is no clock, so no cue past 0ms can fire. This
        // is the one browser policy that silently breaks the whole product.
        <div className="banner is-warning">
          Your browser blocked audio until you interact with the page.
          <button className="banner-action" onClick={() => void enableAudio()}>
            Enable audio
          </button>
        </div>
      )}

      {error && <div className="banner is-error">⚠ {error}</div>}

      {info && !info.retrieval.available && (
        <div className="banner is-muted">
          Teaching without your uploaded materials — {info.retrieval.detail}
        </div>
      )}

      <main className="tutor-body">
        <section className="tutor-col" aria-label="Tutor">
          <div className="tutor-stage">
            {avatarTrack ? (
              <AvatarVideo track={avatarTrack} />
            ) : (
              <div className="tutor-portrait">
                <Trudy pose={status === "live" ? "wave" : "idle"} expression="happy" size={220} />
                <div className="tutor-label">
                  {status === "live"
                    ? "Listening — just talk"
                    : status === "idle"
                      ? "Start a lesson to begin"
                      : detail || STATUS_LABELS[status]}
                </div>
                {status === "live" && (
                  <p className="tutor-sub">
                    This persona has no avatar. The voice is live; the board is
                    drawing in time with it.
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="session-meta">
            {worstDrift && (
              <div className="meta-row" title="Difference between when an action was meant to land and when it did">
                <span className="meta-label">cue drift</span>
                <span className={`drift-chip is-${worstDrift.band}`}>
                  {worstDrift.driftMs >= 0 ? "+" : ""}
                  {worstDrift.driftMs}ms
                </span>
                <span className="meta-sub">{worstDrift.action}</span>
              </div>
            )}
            {info && (
              <div className="meta-row">
                <span className="meta-label">room</span>
                <span className="meta-sub">{info.room}</span>
              </div>
            )}
          </div>

          {log.length > 0 && (
            <ul className="session-log">
              {log.slice(0, 6).map((line) => (
                <li key={line.id} className={`log-line is-${line.tone}`}>
                  {line.message}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="whiteboard-panel" aria-label="Whiteboard">
          <div className="whiteboard-frame">
            <div className="whiteboard-surface">
              <Board
                board={board}
                userId={userId}
                onParameterChange={setParameter}
                onSelectShape={selectShape}
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

function AvatarVideo({ track }: { track: RemoteVideoTrack }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  // Muted on purpose: with an avatar active the agent routes audio through it,
  // and the audio element that IS the playback clock is already playing it.
  // Unmuting here plays every word twice, slightly offset.
  return <video className="avatar-video" ref={ref} autoPlay playsInline muted />;
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

function MicIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0" />
      <path d="M12 17v4" />
      {muted && <path d="M4 4l16 16" />}
    </svg>
  );
}
