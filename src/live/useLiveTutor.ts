/**
 * useLiveTutor — the browser side of a live voice session with the tutor agent.
 *
 * Flow: POST /api/live/session mints a LiveKit room (metadata names the
 * persona) + a learner token. We join, publish the microphone, and play
 * whatever the tutor publishes: its voice (an audio track — published by the
 * agent worker directly, or republished by the avatar vendor on its behalf)
 * and, when the persona has an avatar, a talking-head video track.
 *
 * The whiteboard IS here now, as a bridge rather than a renderer: the agent
 * emits canvas actions on the "canvas" data topic, each carrying a `cueMs`
 * derived from real TTS timestamps. This hook validates them, holds them in a
 * LiveCueQueue clocked off the tutor's own audio element (never wall-clock),
 * and hands each one to `onBoardCue` at the moment the narration reaches it.
 * What a fired action *does* to the board belongs to whoever renders one:
 * by default cues go out over the board-cue bus (boardCueBus.ts) and the
 * shell applies them — so the sync holds no matter which React tree ends up
 * owning this hook as the app shell churns.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteVideoTrack,
} from "livekit-client";
import { CANVAS_TOPIC, LiveCueQueue, PlaybackClock, type BoardCue } from "./cueBridge";
import { publishBoardCue } from "./boardCueBus";

export type { BoardCue } from "./cueBridge";

export type LiveTutorStatus = "idle" | "connecting" | "live";

export interface LiveTutorState {
  status: LiveTutorStatus;
  /** Why the last session attempt failed, when it did. */
  error: string | null;
  /** Persona id of the active (or connecting) session. */
  persona: string | null;
  micEnabled: boolean;
  /** Mic permission problems don't kill the session — surfaced separately. */
  micError: string | null;
  /** True once the agent worker (or its avatar) is in the room. */
  tutorPresent: boolean;
  /** True while a remote participant is talking — drives the orb pulse. */
  tutorSpeaking: boolean;
  /** The avatar's face, when the persona has one. Attach to a <video>. */
  videoTrack: RemoteVideoTrack | null;
}

const IDLE: LiveTutorState = {
  status: "idle",
  error: null,
  persona: null,
  micEnabled: false,
  micError: null,
  tutorPresent: false,
  tutorSpeaking: false,
  videoTrack: null,
};

export interface LiveTutorApi {
  state: LiveTutorState;
  start: (personaId: string) => Promise<void>;
  end: () => void;
  toggleMic: () => Promise<void>;
}

export function useLiveTutor(
  onBoardCue: (cue: BoardCue) => void = publishBoardCue
): LiveTutorApi {
  const [state, setState] = useState<LiveTutorState>(IDLE);
  const roomRef = useRef<Room | null>(null);
  // Hidden <audio> elements for remote audio tracks, keyed by track sid.
  const audioElsRef = useRef<Map<string, HTMLMediaElement>>(new Map());
  // Ref-indirected so a re-rendered caller doesn't rewire room listeners.
  const boardCueRef = useRef(onBoardCue);
  boardCueRef.current = onBoardCue;
  const rafRef = useRef(0);

  const patch = useCallback((p: Partial<LiveTutorState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  const cleanup = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    for (const el of audioElsRef.current.values()) el.remove();
    audioElsRef.current.clear();
    roomRef.current = null;
    setState(IDLE);
  }, []);

  const end = useCallback(() => {
    const room = roomRef.current;
    if (room) {
      // Disconnected event does the state cleanup.
      void room.disconnect();
    } else {
      cleanup();
    }
  }, [cleanup]);

  // Leave the room when the component unmounts mid-session.
  useEffect(() => {
    return () => {
      void roomRef.current?.disconnect();
    };
  }, []);

  const start = useCallback(
    async (personaId: string) => {
      if (roomRef.current) return; // already connecting or live
      setState({ ...IDLE, status: "connecting", persona: personaId });

      let session: { url: string; token: string };
      try {
        const res = await fetch("/api/live/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ personaId }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `session failed (${res.status})`);
        session = body;
      } catch (err) {
        setState({ ...IDLE, error: (err as Error).message });
        return;
      }

      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;

      // One clock + queue per session. The clock follows whichever tutor
      // audio element is current (the worker publishes exactly one voice
      // track, whether directly or via the avatar), so last-attached wins.
      const clock = new PlaybackClock();
      const queue = new LiveCueQueue(clock, (cue) => boardCueRef.current?.(cue));

      const syncPresence = () => {
        patch({ tutorPresent: room.remoteParticipants.size > 0 });
      };

      room
        .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
          if (track.kind === Track.Kind.Audio) {
            // Attach off-DOM-visible: audio needs no layout, and the Start
            // click satisfies the autoplay gesture requirement.
            const el = track.attach();
            el.style.display = "none";
            document.body.appendChild(el);
            audioElsRef.current.set(track.sid ?? String(audioElsRef.current.size), el);
            // This element is now the narration — cue timing reads from it.
            clock.attach(el);
          } else if (track.kind === Track.Kind.Video) {
            patch({ videoTrack: track as RemoteVideoTrack });
          }
        })
        .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
          for (const el of track.detach()) {
            clock.detach(el);
            el.remove();
          }
          if (track.kind === Track.Kind.Audio && track.sid) {
            audioElsRef.current.delete(track.sid);
          }
          if (track.kind === Track.Kind.Video) {
            setState((s) =>
              s.videoTrack === track ? { ...s, videoTrack: null } : s
            );
          }
        })
        .on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
          if (topic === CANVAS_TOPIC) queue.acceptRaw(payload);
        })
        .on(RoomEvent.ParticipantConnected, syncPresence)
        .on(RoomEvent.ParticipantDisconnected, syncPresence)
        .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
          patch({
            tutorSpeaking: speakers.some(
              (p) => p.identity !== room.localParticipant.identity
            ),
          });
        })
        .on(RoomEvent.Disconnected, cleanup);

      try {
        await room.connect(session.url, session.token);
      } catch (err) {
        roomRef.current = null;
        setState({ ...IDLE, error: `could not join the room: ${(err as Error).message}` });
        return;
      }

      // Fire cues from a rAF loop against the audio clock. Poll granularity
      // is one frame (~16ms), well inside the <50ms "good" drift band.
      const tickLoop = () => {
        queue.tick();
        rafRef.current = requestAnimationFrame(tickLoop);
      };
      rafRef.current = requestAnimationFrame(tickLoop);

      patch({ status: "live", tutorPresent: room.remoteParticipants.size > 0 });

      // Mic last: a denied permission should leave the session listening-only,
      // not dead — the learner can still hear the tutor and re-enable later.
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
        patch({ micEnabled: true });
      } catch (err) {
        patch({
          micEnabled: false,
          micError:
            (err as Error).name === "NotAllowedError"
              ? "Microphone permission was denied — the tutor can't hear you."
              : `Microphone unavailable: ${(err as Error).message}`,
        });
      }
    },
    [cleanup, patch]
  );

  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !room.localParticipant.isMicrophoneEnabled;
    try {
      await room.localParticipant.setMicrophoneEnabled(next);
      patch({ micEnabled: next, micError: null });
    } catch (err) {
      patch({ micError: `Microphone unavailable: ${(err as Error).message}` });
    }
  }, [patch]);

  return { state, start, end, toggleMic };
}
