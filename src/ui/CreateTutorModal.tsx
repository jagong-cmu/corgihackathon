/**
 * CreateTutorModal — create a tutor on-site by recording a voice sample and
 * taking a webcam photo (with upload fallbacks), then saving it to the roster.
 *
 * Renders nothing unless the shared TutorContext has `createOpen` set. Closes on
 * the X button, a backdrop click, or Escape; always tears down live media and
 * resets local state on close so no camera/mic stream leaks.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTutors } from "../tutors/TutorContext";
import { useCamera, useMicRecorder } from "../tutors/useMediaCapture";
import "./createTutor.css";

function formatTime(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function CreateTutorModal() {
  const { createOpen, closeCreate, addTutor } = useTutors();
  const camera = useCamera();
  const mic = useMicRecorder();

  const [name, setName] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [uploadedVoice, setUploadedVoice] = useState<string | null>(null);

  const photoInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  const voiceUrl = uploadedVoice ?? mic.audioUrl;

  const resetLocal = useCallback(() => {
    setName("");
    setPhoto(null);
    setUploadedVoice(null);
    if (photoInputRef.current) photoInputRef.current.value = "";
    if (audioInputRef.current) audioInputRef.current.value = "";
    mic.reset();
  }, [mic]);

  const handleClose = useCallback(() => {
    camera.stop();
    mic.stop();
    resetLocal();
    closeCreate();
  }, [camera, mic, resetLocal, closeCreate]);

  // Escape closes while open.
  useEffect(() => {
    if (!createOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createOpen, handleClose]);

  if (!createOpen) return null;

  const takePhoto = () => {
    const d = camera.capture(512);
    if (d) {
      setPhoto(d);
      camera.stop();
    }
  };

  const retake = () => {
    setPhoto(null);
    void camera.start();
  };

  const onPhotoFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setPhoto(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const onAudioFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadedVoice(URL.createObjectURL(file));
  };

  const canCreate = Boolean(name.trim()) && Boolean(photo);

  const handleCreate = () => {
    if (!canCreate) return;
    addTutor({
      name,
      photo: photo ?? undefined,
      voiceUrl: voiceUrl ?? undefined,
    });
    camera.stop();
    mic.stop();
    resetLocal();
    closeCreate();
  };

  return (
    <div
      className="ct-backdrop"
      onClick={handleClose}
      role="presentation"
    >
      <div
        className="ct-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ct-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="ct-close"
          aria-label="Close"
          onClick={handleClose}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              d="M6 6l12 12M18 6L6 18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <h2 id="ct-title" className="ct-title">
          Create a tutor
        </h2>

        {/* Name -------------------------------------------------------- */}
        <label className="ct-field">
          <span className="ct-label">Name</span>
          <input
            className="ct-input"
            type="text"
            value={name}
            placeholder="e.g. Professor Vector"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        {/* Photo ------------------------------------------------------- */}
        <div className="ct-section">
          <span className="ct-label">Photo</span>
          <div className="ct-photo">
            {photo ? (
              <img className="ct-photo-media" src={photo} alt="Tutor" />
            ) : camera.ready ? (
              <video
                className="ct-photo-media ct-mirror"
                ref={camera.videoRef}
                autoPlay
                muted
                playsInline
              />
            ) : (
              <div className="ct-photo-placeholder" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="44" height="44">
                  <path
                    d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinejoin="round"
                  />
                  <circle
                    cx="12"
                    cy="13"
                    r="3.2"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  />
                </svg>
              </div>
            )}
          </div>

          <div className="ct-controls">
            {photo ? (
              <button type="button" className="ct-btn" onClick={retake}>
                Retake
              </button>
            ) : camera.ready ? (
              <button type="button" className="ct-btn" onClick={takePhoto}>
                Take photo
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="ct-btn"
                  onClick={() => void camera.start()}
                >
                  Enable camera
                </button>
                <label className="ct-btn ct-btn-ghost">
                  Upload photo
                  <input
                    ref={photoInputRef}
                    className="ct-file"
                    type="file"
                    accept="image/*"
                    onChange={onPhotoFile}
                  />
                </label>
              </>
            )}
          </div>
          {camera.error && <p className="ct-warn">{camera.error}</p>}
        </div>

        {/* Voice ------------------------------------------------------- */}
        <div className="ct-section">
          <span className="ct-label">Voice</span>
          {mic.recording ? (
            <div className="ct-record">
              <span className="ct-dot" aria-hidden="true" />
              <span className="ct-timer">{formatTime(mic.seconds)}</span>
              <button type="button" className="ct-btn" onClick={mic.stop}>
                Stop
              </button>
            </div>
          ) : voiceUrl ? (
            <div className="ct-record">
              <audio className="ct-audio" controls src={voiceUrl} />
              <button
                type="button"
                className="ct-btn"
                onClick={() => {
                  setUploadedVoice(null);
                  if (audioInputRef.current) audioInputRef.current.value = "";
                  mic.reset();
                }}
              >
                Re-record
              </button>
            </div>
          ) : (
            <div className="ct-controls">
              <button
                type="button"
                className="ct-btn"
                onClick={() => void mic.start()}
              >
                Record voice
              </button>
              <label className="ct-btn ct-btn-ghost">
                Upload audio
                <input
                  ref={audioInputRef}
                  className="ct-file"
                  type="file"
                  accept="audio/*"
                  onChange={onAudioFile}
                />
              </label>
            </div>
          )}
          <p className="ct-hint">~10 seconds of natural speech works best.</p>
          {mic.error && <p className="ct-warn">{mic.error}</p>}
        </div>

        {/* Footer ------------------------------------------------------ */}
        <div className="ct-footer">
          <button type="button" className="ct-btn ct-btn-ghost" onClick={handleClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ct-btn ct-btn-primary"
            disabled={!canCreate}
            onClick={handleCreate}
          >
            Create tutor
          </button>
        </div>
      </div>
    </div>
  );
}
