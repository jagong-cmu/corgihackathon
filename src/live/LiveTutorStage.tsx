/**
 * LiveTutorStage — the tutor's side of the desk, now live.
 *
 * Replaces the "Voice · coming soon" placeholder in TutorShell's left column.
 * Idle: pick a tutor and start a session. Live: the avatar's face (when the
 * persona has one) or a speaking orb, plus mic + end-session controls.
 *
 * Persona options come from the persona API (custom tutors) and fall back to
 * the built-in YAML personas when the API isn't running, mirroring exactly
 * what the agent worker itself can load.
 */
import { useEffect, useRef, useState } from "react";
import { useLiveTutor } from "./useLiveTutor";
import {
  BUILTIN_TUTORS,
  listDeployedTutors,
  listTutors,
  toOption,
  tutorApiAvailable,
  type TutorOption,
} from "../tutorApi";

interface Props {
  /** Bump to re-fetch tutor options (e.g. after creating one in the panel). */
  refresh?: number;
  /** Open the voice-tutor manager (create/voice/avatar), when the host has one. */
  onManage?: () => void;
}

export function LiveTutorStage({ refresh = 0, onManage }: Props) {
  const { state, start, end, toggleMic, setNarrationElement } = useLiveTutor();
  const [options, setOptions] = useState<TutorOption[]>(BUILTIN_TUTORS);
  const [selected, setSelected] = useState<string>(BUILTIN_TUTORS[0].id);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // LiveKit configured on this host?
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
      if (await tutorApiAvailable()) {
        try {
          const fromApi = (await listTutors()).map(toOption);
          if (cancelled || !fromApi.length) return;
          const seen = new Set(fromApi.map((t) => t.id));
          setOptions([...fromApi, ...BUILTIN_TUTORS.filter((t) => !seen.has(t.id))]);
          return;
        } catch {
          /* API up but listing failed (e.g. DB down) — try the next tier */
        }
      }
      const deployed = await listDeployedTutors();
      if (!cancelled && deployed) setOptions(deployed);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Show the avatar's face the moment its video track arrives. Its voice
  // attaches to the SAME element: one shared MediaStream is what makes the
  // browser hold lips and audio together — split across elements they drift.
  // When the voice rides this element it is also the narration the whiteboard
  // cues must clock against, so register it with the hook.
  useEffect(() => {
    const video = state.videoTrack;
    const audio = state.videoAudioTrack;
    const el = videoRef.current;
    if (!video || !el) return;
    video.attach(el);
    audio?.attach(el);
    if (audio) setNarrationElement(el);
    return () => {
      video.detach(el);
      audio?.detach(el);
      if (audio) setNarrationElement(null);
    };
  }, [state.videoTrack, state.videoAudioTrack, setNarrationElement]);

  const active = options.find((t) => t.id === (state.persona ?? selected));
  const name = active?.name ?? state.persona ?? selected;

  // ---------------------------------------------------------------- live
  if (state.status === "live") {
    return (
      <div className="live-stage" data-speaking={state.tutorSpeaking || undefined}>
        <div className="live-face">
          {/* The video element stays mounted so attach() has a target the
              instant the avatar publishes; the orb covers it until then.
              NOT muted: the avatar's voice plays through this element too —
              that's what keeps it in lip sync with the face. */}
          <video
            ref={videoRef}
            className="live-video"
            autoPlay
            playsInline
            style={{ display: state.videoTrack ? "block" : "none" }}
          />
          {!state.videoTrack && (
            <div className="tutor-orb live-orb">
              <SoundWaveIcon />
            </div>
          )}
        </div>

        <div className="live-name">{name}</div>
        <div className="live-status">
          {state.tutorPresent
            ? state.tutorSpeaking
              ? "Speaking…"
              : "Listening — just talk"
            : "Waiting for the tutor agent to join…"}
        </div>
        {state.micError && <div className="live-warn">⚠ {state.micError}</div>}

        <div className="live-controls">
          <button type="button" className="icon-btn" onClick={() => void toggleMic()}>
            {state.micEnabled ? <MicOnIcon /> : <MicOffIcon />}
            {state.micEnabled ? "Mute" : "Unmute"}
          </button>
          <button type="button" className="icon-btn live-end" onClick={end}>
            <EndIcon />
            End
          </button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------- connecting
  if (state.status === "connecting") {
    return (
      <div className="live-stage">
        <div className="tutor-orb live-orb live-connecting">
          <SoundWaveIcon />
        </div>
        <div className="live-name">{name}</div>
        <div className="live-status">Ringing your tutor…</div>
        <div className="live-controls">
          <button type="button" className="icon-btn live-end" onClick={end}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- idle
  return (
    <div className="live-stage">
      <div className="tutor-orb live-orb">
        <SoundWaveIcon />
      </div>
      <div className="live-name">Talk to your tutor</div>
      <p className="tutor-sub">
        A live voice session — your tutor listens, answers, and can appear
        face-to-face when they have an avatar.
      </p>

      <div className="live-picker">
        <select
          className="live-select"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          aria-label="Choose a tutor"
        >
          {options.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.avatarProvider !== "none" ? " · avatar" : ""}
              {!t.hasVoice ? " · no voice yet" : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ask-btn live-start"
          disabled={configured === false}
          onClick={() => void start(selected)}
        >
          Start session
        </button>
      </div>

      {configured === false && (
        <div className="live-warn">
          LiveKit isn't configured — add LIVEKIT_URL / _API_KEY / _API_SECRET to
          .env.local (see LIVE_TUTOR.md).
        </div>
      )}
      {state.error && <div className="live-warn">⚠ {state.error}</div>}

      {onManage && (
        <button type="button" className="live-manage" onClick={onManage}>
          Create &amp; manage voice tutors
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ icons */

function SoundWaveIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 10v4" />
      <path d="M8 7v10" />
      <path d="M12 4v16" />
      <path d="M16 7v10" />
      <path d="M20 10v4" />
    </svg>
  );
}

function MicOnIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0" />
      <path d="M12 17v4" />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0" />
      <path d="M12 17v4" />
      <path d="M4 4l16 16" />
    </svg>
  );
}

function EndIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12c6-5 12-5 18 0" />
      <path d="M7 10.5v3l-3 .5v-3z" />
      <path d="M17 10.5v3l3 .5v-3z" />
    </svg>
  );
}
