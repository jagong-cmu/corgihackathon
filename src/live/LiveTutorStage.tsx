/**
 * LiveTutorStage — the tutor's presence in the left-column card.
 *
 * One tutor, one card: idle it shows the active tutor (Trudy, a created tutor,
 * or a persona from the API) with the "now saying" line; connecting/live the
 * SAME spot becomes the live session — the avatar's face (or a speaking orb)
 * replaces the still avatar instead of squeezing in beside it.
 *
 * Picking a tutor in the dropdown makes that tutor the active one everywhere
 * (card, greeting, sidebar checkmark) via TutorContext; the roster and the
 * session picker were merged when created tutors got cloned voices.
 *
 * Session state itself lives in LiveTutorProvider (App-level), so this
 * component rendering or not never affects a running session's audio.
 */
import { useEffect, useRef } from "react";
import { useLiveTutorContext } from "./LiveTutorContext";
import { useTutors } from "../tutors/TutorContext";
import { Avatar } from "../ui/Avatar";

interface Props {
  /** The line the tutor is speaking on the whiteboard side (idle only). */
  idleSpeech: string;
  /** "Ready to teach" / "Thinking…" — the ask-bar's voice status (idle only). */
  idleVoiceLabel: string;
}

export function LiveTutorStage({ idleSpeech, idleVoiceLabel }: Props) {
  const { live, options, configured } = useLiveTutorContext();
  const { tutors, activeTutor, setActiveTutor, openManage } = useTutors();
  const { state, start, end, toggleMic, setNarrationElement } = live;
  const videoRef = useRef<HTMLVideoElement>(null);

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

  const personaId = activeTutor.personaId ?? "";
  const selectedOption = options.find((t) => t.id === personaId);
  const liveOption = options.find((t) => t.id === state.persona);
  const liveName = liveOption?.name ?? state.persona ?? activeTutor.name;

  const pickPersona = (id: string) => {
    const tutor = tutors.find((t) => t.personaId === id);
    if (tutor) setActiveTutor(tutor.id);
  };

  // ------------------------------------------------------ connecting / live
  if (state.status !== "idle") {
    const connecting = state.status === "connecting";
    return (
      <div className="live-stage" data-speaking={state.tutorSpeaking || undefined}>
        <div className="live-face">
          {/* The video element stays mounted so attach() has a target the
              instant the avatar publishes; until then the tutor's photo (or
              the orb) holds the spot. NOT muted: the avatar's voice plays
              through this element too — that's what keeps it in lip sync
              with the face. */}
          <video
            ref={videoRef}
            className="live-video"
            autoPlay
            playsInline
            style={{ display: state.videoTrack ? "block" : "none" }}
          />
          {!state.videoTrack &&
            (liveOption?.photoUrl ? (
              <img
                className={`avatar-photo live-photo${connecting ? " live-connecting" : ""}`}
                src={liveOption.photoUrl}
                alt={`${liveName} (tutor)`}
              />
            ) : (
              <div className={`tutor-orb live-orb${connecting ? " live-connecting" : ""}`}>
                <SoundWaveIcon />
              </div>
            ))}
        </div>

        <div className="tutor-id">
          <div className="tutor-name">{liveName}</div>
          <div className="tutor-role">Live session</div>
        </div>
        <div className="live-status">
          {connecting
            ? "Ringing your tutor…"
            : state.tutorPresent
              ? state.tutorSpeaking
                ? "Speaking…"
                : "Listening — just talk"
              : "Waiting for the tutor agent to join…"}
        </div>
        {state.micError && <div className="live-warn">⚠ {state.micError}</div>}

        <div className="live-controls">
          {connecting ? (
            <button type="button" className="icon-btn live-end" onClick={end}>
              Cancel
            </button>
          ) : (
            <>
              <button type="button" className="icon-btn" onClick={() => void toggleMic()}>
                {state.micEnabled ? <MicOnIcon /> : <MicOffIcon />}
                {state.micEnabled ? "Mute" : "Unmute"}
              </button>
              <button type="button" className="icon-btn live-end" onClick={end}>
                <EndIcon />
                End
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- idle
  return (
    <>
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
        {idleVoiceLabel}
      </span>

      <div className="speech">
        <div className="speech-label">
          <span className="dot" aria-hidden /> Now saying
        </div>
        <p className="speech-text">
          <span className="q">“</span>
          {idleSpeech}
          <span className="q">”</span>
        </p>
      </div>

      <div className="live-picker">
        <select
          className="live-select"
          value={personaId}
          onChange={(e) => pickPersona(e.target.value)}
          aria-label="Choose a tutor"
        >
          {!personaId && <option value="">Choose a voice tutor…</option>}
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
          disabled={configured === false || !personaId || selectedOption?.hasVoice === false}
          onClick={() => void start(personaId)}
        >
          Start session
        </button>
      </div>

      {selectedOption?.hasVoice === false && (
        <div className="live-warn">
          {selectedOption.name} has no voice yet — assign one in the Tutors panel
          before starting a session.
        </div>
      )}
      {configured === false && (
        <div className="live-warn">
          LiveKit isn't configured — add LIVEKIT_URL / _API_KEY / _API_SECRET to
          .env.local (see LIVE_TUTOR.md).
        </div>
      )}
      {state.error && <div className="live-warn">⚠ {state.error}</div>}

      <button type="button" className="live-manage" onClick={openManage}>
        Create &amp; manage voice tutors
      </button>
    </>
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
