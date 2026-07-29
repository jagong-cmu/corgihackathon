/**
 * useMediaCapture — thin, well-behaved wrappers over the browser media APIs for
 * creating a tutor on-site:
 *   - useCamera():      live webcam preview + snapshot to a square JPEG data URL
 *   - useMicRecorder():  record a short voice sample to an object URL (webm/ogg)
 *
 * Both degrade gracefully: if permission is denied or no device exists, they
 * surface a human error string instead of throwing, and the Create-Tutor modal
 * offers a file-upload fallback. getUserMedia requires https or localhost — the
 * dev tunnel is https, so it works there.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/* --------------------------------------------------------------- camera --- */

export interface CameraApi {
  videoRef: React.RefObject<HTMLVideoElement>;
  ready: boolean;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  /** Grab the current frame as a square JPEG data URL (center-cropped). */
  capture: (size?: number) => string | null;
}

export function useCamera(): CameraApi {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setReady(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser can't access a camera. Upload a photo instead.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      const v = videoRef.current;
      if (v) {
        v.srcObject = stream;
        await v.play().catch(() => {});
      }
      setReady(true);
    } catch (e) {
      const name = (e as Error).name;
      setError(
        name === "NotAllowedError"
          ? "Camera permission was denied. Allow it, or upload a photo."
          : "Couldn't start the camera. Upload a photo instead."
      );
    }
  }, []);

  const capture = useCallback((size = 512): string | null => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return null;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // Center-crop the video to a square, mirrored (selfie view).
    const side = Math.min(v.videoWidth, v.videoHeight);
    const sx = (v.videoWidth - side) / 2;
    const sy = (v.videoHeight - side) / 2;
    ctx.translate(size, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(v, sx, sy, side, side, 0, 0, size, size);
    return canvas.toDataURL("image/jpeg", 0.85);
  }, []);

  // Attach the stream once the <video> is actually in the DOM. Consumers
  // render the element conditionally on `ready` (the Create-Tutor modal
  // does), so when start() resolves videoRef.current is still null — the
  // in-start() attach below is for consumers that render the video
  // unconditionally. Without this effect the mounted video stays black and
  // capture() sees videoWidth 0: the "Take photo" button that does nothing.
  useEffect(() => {
    const v = videoRef.current;
    const stream = streamRef.current;
    if (!ready || !v || !stream || v.srcObject === stream) return;
    v.srcObject = stream;
    void v.play().catch(() => {});
  }, [ready]);

  // Clean up the stream if the component unmounts mid-capture.
  useEffect(() => stop, [stop]);

  return { videoRef, ready, error, start, stop, capture };
}

/* ------------------------------------------------------------ microphone --- */

export interface MicApi {
  recording: boolean;
  seconds: number;
  audioUrl: string | null;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  reset: () => void;
}

export function useMicRecorder(): MicApi {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clearTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const stop = useCallback(() => {
    recorderRef.current?.state === "recording" && recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    clearTimer();
    setRecording(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("This browser can't record audio. Upload a clip instead.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        setAudioUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
      };
      recorderRef.current = rec;
      rec.start();
      setSeconds(0);
      setRecording(true);
      clearTimer();
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch (e) {
      const name = (e as Error).name;
      setError(
        name === "NotAllowedError"
          ? "Microphone permission was denied. Allow it, or upload a clip."
          : "Couldn't start recording. Upload a clip instead."
      );
    }
  }, []);

  const reset = useCallback(() => {
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setSeconds(0);
  }, []);

  useEffect(() => stop, [stop]);

  return { recording, seconds, audioUrl, error, start, stop, reset };
}
