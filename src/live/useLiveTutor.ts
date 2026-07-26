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
 * The whiteboard IS here too, as a bridge rather than a renderer: the agent
 * emits canvas actions on the "canvas" data topic, each carrying a `cueMs`
 * derived from real TTS timestamps. This hook validates them, holds them in a
 * LiveCueQueue clocked off whichever media element is playing the narration
 * (never wall-clock), and hands each one to `onBoardCue` at the moment the
 * narration reaches it. Voice-only tutors narrate through the hidden <audio>
 * elements owned here; avatar tutors narrate through the stage's <video>,
 * which the stage registers via `setNarrationElement`. What a fired action
 * *does* to the board belongs to whoever renders one: by default cues go out
 * over the board-cue bus (boardCueBus.ts) and the shell applies them — so the
 * sync holds no matter which React tree ends up owning this hook as the app
 * shell churns.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
  Track,
  type RemoteAudioTrack,
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
  /**
   * True when the browser refused to autoplay the tutor's audio (no user
   * gesture on this origin yet — Safari, iOS, fresh deploys). The session is
   * healthy; the user just has to tap once. Surface a button that calls
   * enableAudio(), or the tutor is silent and looks broken.
   */
  audioBlocked: boolean;
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
  audioBlocked: false,
  videoTrack: null,
  videoAudioTrack: null,
};

export interface LiveTutorApi {
  state: LiveTutorState;
  start: (personaId: string) => Promise<void>;
  end: () => void;
  toggleMic: () => Promise<void>;
  /**
   * Tell the cue clock which media element is playing the narration. The
   * stage calls this with its <video> element once it attaches the avatar's
   * voice there (and with null on detach) — whiteboard cues then fire against
   * that element's playback position, keeping the board on the tutor's words
   * even when the voice rides the video. Voice-only sessions need no call:
   * the hook clocks off its own hidden <audio> elements.
   */
  setNarrationElement: (el: HTMLMediaElement | null) => void;
  /** Retry blocked audio playback (must be called from a user gesture). */
  enableAudio: () => Promise<void>;
}

export function useLiveTutor(
  onBoardCue: (cue: BoardCue) => void = publishBoardCue
): LiveTutorApi {
  const [state, setState] = useState<LiveTutorState>(IDLE);
  const roomRef = useRef<Room | null>(null);
  // Hidden <audio> elements for standalone (no sibling video) audio tracks,
  // keyed by track sid. The avatar's voice never lands here — it plays through
  // the stage's <video> element so the browser lip-syncs it with the face.
  const audioElsRef = useRef<
    Map<string, { track: RemoteAudioTrack; el: HTMLMediaElement }>
  >(new Map());
  // Ref-indirected so a re-rendered caller doesn't rewire room listeners.
  const boardCueRef = useRef(onBoardCue);
  boardCueRef.current = onBoardCue;
  const rafRef = useRef(0);
  // The active session's cue clock + the element the stage registered as the
  // narration source (survives across sessions so a stage that mounted before
  // start() still gets its element honored).
  const clockRef = useRef<PlaybackClock | null>(null);
  const narrationElRef = useRef<HTMLMediaElement | null>(null);

  const patch = useCallback((p: Partial<LiveTutorState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  const setNarrationElement = useCallback((el: HTMLMediaElement | null) => {
    const previous = narrationElRef.current;
    narrationElRef.current = el;
    const clock = clockRef.current;
    if (!clock) return;
    if (el) {
      if (clock.element !== el) clock.attach(el);
      return;
    }
    if (previous) clock.detach(previous);
    // The narration element is gone (the avatar died and its tracks left).
    // Fall back to a standalone <audio> element if one exists — the worker
    // republishes its own voice track on avatar death, and without a clock
    // every pending whiteboard cue starves.
    const fallback = audioElsRef.current.values().next().value;
    if (fallback && clock.element !== fallback.el) clock.attach(fallback.el);
  }, []);

  const cleanup = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    clockRef.current = null;
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

      // One clock + queue per session. The clock follows whichever element is
      // playing the narration: a voice-only tutor's hidden <audio> (attached
      // below in syncTracks) or, for avatar personas, the stage's <video>
      // (registered via setNarrationElement).
      const clock = new PlaybackClock();
      clockRef.current = clock;
      if (narrationElRef.current) clock.attach(narrationElRef.current);
      const queue = new LiveCueQueue(clock, (cue) => boardCueRef.current?.(cue));

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
            clock.detach(entry.el);
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

        // Reconcile the cue clock's source: the stage-registered narration
        // element (the avatar's <video>) always wins; otherwise any standalone
        // <audio> (a voice-only tutor, or the worker's re-published voice
        // after avatar death). Never let a random new audio track hijack a
        // registered narration clock — attach() rebases the timeline and
        // strands every in-flight turn's cues.
        const desired = narrationElRef.current ?? els.values().next().value?.el ?? null;
        if (desired) {
          if (clock.element !== desired) clock.attach(desired);
        } else if (clock.element) {
          clock.detach(clock.element);
        }

        patch({ videoTrack, videoAudioTrack });
      };

      room
        .on(RoomEvent.TrackSubscribed, syncTracks)
        .on(RoomEvent.TrackUnsubscribed, syncTracks)
        .on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
          if (topic === CANVAS_TOPIC) queue.acceptRaw(payload);
        })
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
        .on(RoomEvent.AudioPlaybackStatusChanged, () => {
          // attach() swallows a rejected play() — this event is the only
          // signal that the tutor is talking into a muted browser.
          patch({ audioBlocked: !room.canPlaybackAudio });
        })
        .on(RoomEvent.Disconnected, cleanup);

      try {
        await room.connect(session.url, session.token);
      } catch (err) {
        roomRef.current = null;
        clockRef.current = null;
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

  const enableAudio = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.startAudio();
      patch({ audioBlocked: false });
    } catch {
      // Still blocked — the button stays up and the user can tap again.
    }
  }, [patch]);

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

  return { state, start, end, toggleMic, setNarrationElement, enableAudio };
}
