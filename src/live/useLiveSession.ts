/**
 * The one React hook that owns a lesson.
 *
 * Wires the four pieces together and runs the single animation frame loop that
 * drives everything time-based:
 *
 *     rAF tick ──▶ cueQueue.tick()   fire actions the audio has reached
 *              └─▶ board.tick()      expire pointers, advance step reveals
 *
 * Both are driven from the playback clock rather than wall time, so if the
 * tutor's audio stalls the board stalls with it instead of racing ahead of the
 * narration.
 *
 * The board itself lives in a `BoardStore` outside React and is read through
 * `useSyncExternalStore`. Actions arrive on a data channel and fire from a rAF
 * callback — neither is a React event, and routing them through setState is how
 * you end up with a stale-closure bug that drops one action in twenty.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { RemoteVideoTrack } from "livekit-client";
import { BoardStore } from "../board/store";
import { PlaybackClock } from "./clock";
import { CueQueue, driftBand } from "./cueQueue";
import { LiveSession, type SessionStatus } from "./room";
import type { SessionInfo } from "../api";

export interface DriftSample {
  action: string;
  driftMs: number;
  band: "good" | "warn" | "bad";
}

export interface LogLine {
  id: number;
  message: string;
  tone: "info" | "warn" | "error";
}

const MAX_LOG_LINES = 40;

export function useLiveSession() {
  // One audio element for the whole session. Created imperatively rather than
  // rendered, because it is not a UI control — it is the clock.
  const audioEl = useMemo(() => {
    const el = typeof Audio === "undefined" ? null : new Audio();
    if (el) {
      el.autoplay = true;
      // Muted autoplay would defeat the point: the learner needs to hear this,
      // and a muted element's currentTime would still advance, so cues would
      // fire against audio nobody heard.
      el.muted = false;
    }
    return el;
  }, []);

  const boardStore = useMemo(() => new BoardStore(), []);
  const clock = useMemo(() => new PlaybackClock(audioEl ?? new Audio()), [audioEl]);

  const [status, setStatus] = useState<SessionStatus>("idle");
  const [detail, setDetail] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [avatarTrack, setAvatarTrack] = useState<RemoteVideoTrack | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [micEnabled, setMicEnabled] = useState(true);
  const [drift, setDrift] = useState<DriftSample[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const logId = useRef(0);

  const addLog = useCallback((message: string, tone: LogLine["tone"] = "info") => {
    setLog((lines) => [{ id: logId.current++, message, tone }, ...lines].slice(0, MAX_LOG_LINES));
  }, []);

  const cues = useMemo(
    () =>
      new CueQueue(clock, {
        onFire: (cue) => {
          boardStore.apply(cue.action, clock.positionMs);
          setDrift((samples) =>
            [
              { action: cue.action.type, driftMs: cue.driftMs, band: driftBand(cue.driftMs) },
              ...samples,
            ].slice(0, 12),
          );
        },
        onCancel: (turnId, reason) => addLog(`Turn ${turnId} cancelled — ${reason}.`, "warn"),
        onWarning: (message) => addLog(message, "warn"),
      }),
    [clock, boardStore, addLog],
  );

  const live = useMemo(
    () =>
      new LiveSession(clock, cues, {
        onStatus: (next, why) => {
          setStatus(next);
          if (why !== undefined) setDetail(why);
        },
        onAvatarTrack: setAvatarTrack,
        onLog: (message, tone = "info") => addLog(message, tone),
        onAudioBlocked: () => {
          setAudioBlocked(true);
          addLog("Your browser blocked audio autoplay — click 'enable audio' to start.", "warn");
        },
      }),
    [clock, cues, addLog],
  );

  // The single time source for everything that is not a discrete event.
  useEffect(() => {
    let frame = 0;
    const loop = () => {
      cues.tick();
      boardStore.tick(clock.positionMs);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [cues, boardStore, clock]);

  useEffect(() => {
    return () => {
      void live.disconnect();
    };
  }, [live]);

  const board = useSyncExternalStore(boardStore.subscribe, boardStore.getSnapshot);

  const connect = useCallback(
    async (options: { persona?: string } = {}) => {
      setError(null);
      setAudioBlocked(false);
      boardStore.reset();
      try {
        const session = await live.connect(options);
        setInfo(session);
        setMicEnabled(true);
        if (!session.retrieval.available) {
          addLog(
            `Teaching without your materials — ${session.retrieval.detail ?? "retrieval is off"}.`,
            "warn",
          );
        }
        return session;
      } catch (err) {
        const message = (err as Error).message;
        setError(message);
        setStatus("error");
        addLog(message, "error");
        throw err;
      }
    },
    [live, boardStore, addLog],
  );

  const disconnect = useCallback(async () => {
    await live.disconnect();
    setInfo(null);
    setDrift([]);
  }, [live]);

  const toggleMic = useCallback(async () => {
    const next = !live.microphoneEnabled;
    await live.setMicrophoneEnabled(next);
    setMicEnabled(next);
    // Muting is the learner's "I'm thinking, stop listening" control, so it is
    // worth an explicit line rather than only a changed icon.
    addLog(next ? "Microphone on." : "Microphone muted — the tutor cannot hear you.");
  }, [live, addLog]);

  const enableAudio = useCallback(async () => {
    try {
      await live.resumeAudio();
      setAudioBlocked(false);
    } catch (err) {
      addLog(`Could not start audio: ${(err as Error).message}`, "error");
    }
  }, [live, addLog]);

  /** A learner dragging a graph parameter. Local first, then tell the agent. */
  const setParameter = useCallback(
    (shapeId: string, name: string, value: number) => {
      boardStore.setParameter(shapeId, name, value);
      void live.sendStudentEvent("sim_param_changed", [shapeId], { param: name, value });
    },
    [boardStore, live],
  );

  const selectShape = useCallback(
    (shapeId: string) => {
      void live.sendStudentEvent("selected", [shapeId]);
    },
    [live],
  );

  return {
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
    frames: live.frames.stats,
    connect,
    disconnect,
    toggleMic,
    enableAudio,
    setParameter,
    selectShape,
    userId: info?.userId ?? null,
  };
}

export type LiveSessionApi = ReturnType<typeof useLiveSession>;
