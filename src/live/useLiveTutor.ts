/**
 * useLiveTutor — the browser side of a live voice session with the tutor agent.
 *
 * Flow: POST /api/live/session mints a LiveKit room (metadata names the
 * persona) + a learner token. We join, publish the microphone, and play
 * whatever the tutor publishes: its voice (an audio track — published by the
 * agent worker directly, or republished by the avatar vendor on its behalf)
 * and, when the persona has an avatar, a talking-head video track. When both
 * come from the avatar they must play from ONE media element — the browser
 * only lip-syncs audio with video inside a shared MediaStream — so the pair
 * is exposed together and the stage attaches them to the same <video>.
 *
 * Deliberately NOT here: the whiteboard. The agent also emits canvas actions
 * on the "canvas" data topic; this hook never subscribes to them — drawing
 * and cue sync belong to the visual subsystem and are out of scope.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
  Track,
  type RemoteAudioTrack,
  type RemoteVideoTrack,
} from "livekit-client";

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
  /**
   * The avatar's voice — audio published by the same participant as
   * videoTrack. Attach it to the SAME element as the video: a shared
   * MediaStream is what makes the browser hold lips and voice together.
   */
  videoAudioTrack: RemoteAudioTrack | null;
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
  videoAudioTrack: null,
};

export interface LiveTutorApi {
  state: LiveTutorState;
  start: (personaId: string) => Promise<void>;
  end: () => void;
  toggleMic: () => Promise<void>;
}

export function useLiveTutor(): LiveTutorApi {
  const [state, setState] = useState<LiveTutorState>(IDLE);
  const roomRef = useRef<Room | null>(null);
  // Hidden <audio> elements for standalone (no sibling video) audio tracks,
  // keyed by track sid. The avatar's voice never lands here — it plays through
  // the stage's <video> element so the browser lip-syncs it with the face.
  const audioElsRef = useRef<
    Map<string, { track: RemoteAudioTrack; el: HTMLMediaElement }>
  >(new Map());

  const patch = useCallback((p: Partial<LiveTutorState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  const cleanup = useCallback(() => {
    for (const { track, el } of audioElsRef.current.values()) {
      track.detach(el);
      el.remove();
    }
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

      const syncPresence = () => {
        patch({ tutorPresent: room.remoteParticipants.size > 0 });
      };

      // Route remote tracks by participant. An avatar publishes BOTH the face
      // and the voice, and the browser only lip-syncs audio with video when
      // they play from one shared MediaStream — so that pair is handed to the
      // stage's <video> together, and only audio with no sibling video (a
      // voice-only tutor) gets its own hidden <audio> element. Recomputed from
      // room state on every track change rather than patched incrementally, so
      // subscription order (voice before face or after) can't split the pair.
      const syncTracks = () => {
        let videoTrack: RemoteVideoTrack | null = null;
        let videoAudioTrack: RemoteAudioTrack | null = null;
        const standalone = new Map<string, RemoteAudioTrack>();

        for (const participant of room.remoteParticipants.values()) {
          let video: RemoteVideoTrack | null = null;
          const audio: RemoteAudioTrack[] = [];
          for (const pub of participant.trackPublications.values()) {
            const track = pub.track;
            if (!track) continue;
            if (track.kind === Track.Kind.Video) {
              video = video ?? (track as RemoteVideoTrack);
            } else if (track.kind === Track.Kind.Audio) {
              audio.push(track as RemoteAudioTrack);
            }
          }
          if (video && !videoTrack) {
            videoTrack = video;
            videoAudioTrack = audio.shift() ?? null;
          }
          for (const track of audio) {
            standalone.set(track.sid ?? String(standalone.size), track);
          }
        }

        const els = audioElsRef.current;
        for (const [sid, entry] of els) {
          if (standalone.get(sid) !== entry.track) {
            entry.track.detach(entry.el);
            entry.el.remove();
            els.delete(sid);
          }
        }
        for (const [sid, track] of standalone) {
          if (!els.has(sid)) {
            // Attach off-DOM-visible: audio needs no layout, and the Start
            // click satisfies the autoplay gesture requirement.
            const el = track.attach();
            el.style.display = "none";
            document.body.appendChild(el);
            els.set(sid, { track, el });
          }
        }

        patch({ videoTrack, videoAudioTrack });
      };

      room
        .on(RoomEvent.TrackSubscribed, syncTracks)
        .on(RoomEvent.TrackUnsubscribed, syncTracks)
        .on(RoomEvent.ParticipantConnected, syncPresence)
        .on(RoomEvent.ParticipantDisconnected, () => {
          syncPresence();
          syncTracks();
        })
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

      patch({ status: "live", tutorPresent: room.remoteParticipants.size > 0 });
      // Anything subscribed while connect() was resolving never fired the
      // handlers above — pick it up now.
      syncTracks();

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
