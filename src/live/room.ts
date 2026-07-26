/**
 * The lesson transport.
 *
 * Joins the LiveKit room the API minted a token for, publishes the learner's
 * microphone, subscribes to the tutor's audio and the avatar's video, and feeds
 * every canvas frame through the validation boundary into the cue queue.
 *
 * Four streams, one room:
 *
 *   mic      browser  -> agent     the learner talking (STT input)
 *   audio    agent    -> browser   the tutor's voice; also the playback clock
 *   video    avatar   -> browser   the face, when a persona has one
 *   data     agent    -> browser   canvas_action / cancel_turn on the "canvas" topic
 *            browser  -> agent     client_hello / student_event
 *
 * The audio track is load-bearing twice over: it is what the learner hears, and
 * it is the clock every board action is timed against. If it never attaches,
 * cues past 0ms never fire — which is why `onAudioBlocked` exists rather than a
 * silent failure.
 */

import {
  ConnectionState,
  RemoteAudioTrack,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
} from "livekit-client";
import { ACTION_NAMES, PROTOCOL_VERSION } from "@tutor/canvas-protocol";
import type { PlaybackClock } from "./clock";
import { FrameGate } from "./frames";
import { CueQueue } from "./cueQueue";
import { startSession, type SessionInfo } from "../api";

/** The topic the agent publishes canvas traffic on (mirrors CANVAS_TOPIC). */
const CANVAS_TOPIC = "canvas";

export type SessionStatus =
  | "idle"
  | "connecting"
  | "waiting-for-tutor"
  | "live"
  | "reconnecting"
  | "error";

export interface LiveSessionEvents {
  onStatus(status: SessionStatus, detail?: string): void;
  onAvatarTrack(track: RemoteVideoTrack | null): void;
  onLog(message: string, tone?: "info" | "warn" | "error"): void;
  /** Autoplay policy blocked the tutor's audio; the UI must offer a click. */
  onAudioBlocked(): void;
}

export class LiveSession {
  private readonly clock: PlaybackClock;
  private readonly cues: CueQueue;
  private readonly events: LiveSessionEvents;
  readonly frames = new FrameGate();

  private room: Room | null = null;
  private audioTrack: RemoteAudioTrack | null = null;
  private info: SessionInfo | null = null;

  constructor(clock: PlaybackClock, cues: CueQueue, events: LiveSessionEvents) {
    this.clock = clock;
    this.cues = cues;
    this.events = events;
  }

  get connected(): boolean {
    return this.room?.state === ConnectionState.Connected;
  }

  get session(): SessionInfo | null {
    return this.info;
  }

  async connect(options: { persona?: string; userId?: string } = {}): Promise<SessionInfo> {
    if (this.room) await this.disconnect();

    this.events.onStatus("connecting", "asking the API for a room");
    const info = await startSession(options);
    this.info = info;

    const room = new Room({
      adaptiveStream: false,
      dynacast: false,
      // The tutor's voice is the clock. Anything that resamples or buffers it
      // adds directly to cue drift, so the browser's processing is left off
      // except for the parts that make a laptop mic usable in a room.
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.room = room;
    this.wire(room);

    this.events.onStatus("connecting", `joining ${info.room}`);
    await room.connect(info.url, info.token);

    // Publish the mic before announcing ourselves: the agent starts
    // transcribing on track_subscribed, and a hello that arrives first would
    // have it waiting on audio that is still negotiating.
    //
    // A refused mic does not end the lesson. The learner can still hear the
    // tutor and watch the board, which is most of the value, and they get told
    // why they cannot be heard — far better than a connect that fails with a
    // permissions error and no session at all.
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch (err) {
      this.events.onLog(
        `Microphone unavailable (${(err as Error).message}). You can hear the tutor, ` +
          "but it cannot hear you until you allow mic access and rejoin.",
        "warn",
      );
    }
    await this.sayHello();

    this.events.onStatus("waiting-for-tutor", "waiting for the tutor to join");
    this.events.onLog(`Joined ${info.room} as ${info.identity}.`);

    // Tracks published before we joined do not fire TrackSubscribed again.
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.track) this.onTrack(publication.track, participant);
      }
    }
    return info;
  }

  private wire(room: Room): void {
    room.on(RoomEvent.DataReceived, (payload: Uint8Array, _p, _kind, topic?: string) => {
      if (topic && topic !== CANVAS_TOPIC) return;
      const message = this.frames.parse(payload);
      if (message) this.cues.accept(message);
    });

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant) => {
      this.onTrack(track, participant);
    });

    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      if (track === this.audioTrack) {
        track.detach(this.clock.el);
        this.audioTrack = null;
        this.clock.detach();
        this.events.onLog("The tutor's audio track ended — the board clock has stopped.", "warn");
      }
      if (track.kind === Track.Kind.Video) this.events.onAvatarTrack(null);
    });

    room.on(RoomEvent.ParticipantConnected, (p) => this.events.onLog(`${p.identity} joined.`));
    room.on(RoomEvent.Reconnecting, () => this.events.onStatus("reconnecting"));
    room.on(RoomEvent.Reconnected, () => this.events.onStatus("live"));
    room.on(RoomEvent.Disconnected, (reason) => {
      this.clock.detach();
      this.events.onStatus("idle", reason ? `disconnected (${reason})` : "disconnected");
    });
  }

  private onTrack(track: RemoteTrack, participant: RemoteParticipant): void {
    if (track.kind === Track.Kind.Video) {
      this.events.onAvatarTrack(track as RemoteVideoTrack);
      this.events.onLog(`Avatar video from ${participant.identity}.`);
      return;
    }
    if (track.kind !== Track.Kind.Audio) return;

    // Already attached. A track published before we joined is delivered twice:
    // once by the catch-up loop in connect() and once by TrackSubscribed. Both
    // paths are needed, so the de-dupe belongs here — without it every session
    // logs a "second audio track" warning that sends you looking for a
    // double-publish that never happened.
    if (this.audioTrack === track) return;

    if (this.audioTrack) {
      // With an avatar active the agent routes audio through it instead of
      // publishing its own track, so there should only ever be one. Two means
      // something is double-publishing and the learner is hearing an echo.
      this.events.onLog(
        `A second audio track arrived from ${participant.identity}; still clocking off the first.`,
        "warn",
      );
      return;
    }

    this.audioTrack = track as RemoteAudioTrack;
    track.attach(this.clock.el);
    // attach() sets srcObject, so currentTime restarts from here.
    this.clock.markAttached("livekit-track");
    this.events.onStatus("live");

    void this.clock.el.play().catch(() => {
      // Autoplay policy. Without playback there is no clock and no cue past
      // 0ms can fire, so this has to surface in the UI rather than the console.
      this.events.onAudioBlocked();
    });
  }

  /**
   * Announce what this client can render (§4).
   *
   * Sent every join, including reconnects. The agent uses it to log a version
   * mismatch — the alternative is a lesson where actions are silently dropped
   * and neither side can tell you why.
   */
  private async sayHello(): Promise<void> {
    await this.publish({
      type: "client_hello",
      protocolVersion: PROTOCOL_VERSION,
      supportedActions: [...ACTION_NAMES],
    });
  }

  /**
   * Tell the agent what the learner just did on the board (§5.3). Folded into
   * the next turn's context so "why is this negative?" can resolve "this".
   */
  async sendStudentEvent(
    kind: "drew" | "selected" | "moved" | "sim_param_changed" | "dropped_image",
    shapeIds: string[],
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await this.publish({
      type: "student_event",
      kind,
      shapeIds,
      detail,
      needsScreenshot: false,
    });
  }

  private async publish(message: unknown): Promise<void> {
    if (!this.room || this.room.state !== ConnectionState.Connected) return;
    await this.room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify(message)),
      { reliable: true, topic: CANVAS_TOPIC },
    );
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    await this.room?.localParticipant.setMicrophoneEnabled(enabled);
  }

  get microphoneEnabled(): boolean {
    return this.room?.localParticipant.isMicrophoneEnabled ?? false;
  }

  /** Retry playback after the learner clicks, when autoplay was blocked. */
  async resumeAudio(): Promise<void> {
    await this.room?.startAudio();
    await this.clock.el.play();
  }

  async disconnect(): Promise<void> {
    const room = this.room;
    this.room = null;
    this.audioTrack = null;
    this.info = null;
    this.clock.detach();
    this.cues.reset();
    this.events.onAvatarTrack(null);
    if (room) await room.disconnect();
    this.events.onStatus("idle");
  }
}
