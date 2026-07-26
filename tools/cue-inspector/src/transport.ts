/**
 * LiveKit subscriber transport.
 *
 * Joins a room subscribe-only, attaches the first remote audio track to the
 * inspector's audio element (that element is the playback clock — see
 * clock.ts), and forwards every data-channel packet to the validation
 * boundary in frames.ts.
 */

import {
  ConnectionState,
  RemoteAudioTrack,
  RemoteParticipant,
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";
import type { PlaybackClock } from "./clock.ts";
import { classifyBytes, type FrameResult } from "./frames.ts";

export interface TransportEvents {
  onFrame(result: FrameResult, from: string): void;
  onStatus(status: string, tone: "idle" | "live" | "error"): void;
  onLog(message: string, tone: "info" | "warn" | "error"): void;
}

export interface TokenResponse {
  url: string;
  token: string;
  identity: string;
  room: string;
}

export class LiveKitTransport {
  private readonly clock: PlaybackClock;
  private readonly events: TransportEvents;
  private room: Room | null = null;
  private audioTrack: RemoteAudioTrack | null = null;

  constructor(clock: PlaybackClock, events: TransportEvents) {
    this.clock = clock;
    this.events = events;
  }

  get connected(): boolean {
    return this.room?.state === ConnectionState.Connected;
  }

  async connect(roomName: string): Promise<void> {
    if (this.room) await this.disconnect();

    this.events.onStatus(`minting token for ${roomName}…`, "idle");
    const res = await fetch(
      `/api/token?room=${encodeURIComponent(roomName)}&identity=inspector-${crypto.randomUUID().slice(0, 8)}`,
    );
    const body = (await res.json()) as TokenResponse | { error: string };
    if (!res.ok || "error" in body) {
      const message = "error" in body ? body.error : `token endpoint returned ${res.status}`;
      this.events.onStatus("no credentials", "error");
      throw new Error(message);
    }

    const room = new Room({ adaptiveStream: false, dynacast: false });
    this.room = room;
    this.wire(room);

    this.events.onStatus(`connecting to ${body.url}…`, "idle");
    await room.connect(body.url, body.token);
    this.events.onStatus(`in ${body.room} as ${body.identity}`, "live");
    this.events.onLog(
      `Connected to ${body.room}. Waiting for the tutor's audio track and canvas_action frames.`,
      "info",
    );

    // Tracks published before we joined don't fire TrackSubscribed again.
    for (const participant of room.remoteParticipants.values()) {
      for (const pub of participant.trackPublications.values()) {
        if (pub.track) this.onTrack(pub.track, participant);
      }
    }
  }

  private wire(room: Room): void {
    room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant) => {
      this.events.onFrame(classifyBytes(payload), participant?.identity ?? "unknown");
    });

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant) => {
      this.onTrack(track, participant);
    });

    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      if (track === this.audioTrack) {
        track.detach(this.clock.el);
        this.audioTrack = null;
        this.clock.detach();
        this.events.onLog("Tutor audio track ended — the playback clock has stopped.", "warn");
      }
    });

    room.on(RoomEvent.Disconnected, (reason) => {
      this.events.onStatus("disconnected", "idle");
      this.events.onLog(`Disconnected from the room (${reason ?? "no reason given"}).`, "warn");
      this.clock.detach();
    });

    room.on(RoomEvent.ParticipantConnected, (p) =>
      this.events.onLog(`Participant joined: ${p.identity}`, "info"),
    );
  }

  private onTrack(track: RemoteTrack, participant: RemoteParticipant): void {
    if (track.kind !== Track.Kind.Audio) {
      this.events.onLog(
        `Ignoring ${track.kind} track from ${participant.identity} — this tool only needs audio.`,
        "info",
      );
      return;
    }
    if (this.audioTrack) {
      this.events.onLog(
        `A second audio track arrived from ${participant.identity}; still clocking off the first.`,
        "warn",
      );
      return;
    }

    this.audioTrack = track as RemoteAudioTrack;
    track.attach(this.clock.el);
    // attach() sets srcObject; currentTime restarts from here.
    this.clock.markAttached("livekit-track");
    void this.clock.el.play().catch((err) => {
      this.events.onLog(
        `Audio autoplay was blocked (${err.message}). Click the audio element's play control — ` +
          "without playback there is no clock and cues cannot fire.",
        "warn",
      );
    });
    this.events.onLog(`Subscribed to audio from ${participant.identity}.`, "info");
  }

  async disconnect(): Promise<void> {
    const room = this.room;
    this.room = null;
    this.audioTrack = null;
    this.clock.detach();
    if (room) await room.disconnect();
  }
}
