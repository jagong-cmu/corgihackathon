/**
 * The playback clock.
 *
 * Everything the board does is timed against `HTMLAudioElement.currentTime` and
 * never against wall-clock time. A canvas action is late if it lands after the
 * words it belongs to have been *heard*, and only the audio element knows when
 * that happened. `Date.now()` would hide exactly the failure this is here to
 * prevent: a stalled or rebuffering track freezes playback while wall time sails
 * on, and every remaining action in the turn fires into silence.
 *
 * The element is fed by a remote LiveKit audio track via `track.attach()`, which
 * sets `srcObject` to a MediaStream. For a MediaStream-backed element
 * `currentTime` means "seconds of audio rendered since playback began" — it
 * starts at zero on attach and stalls when the stream stalls, which is exactly
 * the semantics the cue queue needs.
 */

export type ClockSource = "none" | "livekit-track";

export class PlaybackClock {
  readonly el: HTMLAudioElement;
  private source: ClockSource = "none";
  /** Playback position at the moment the current source was attached. */
  private attachedAtMs = 0;

  constructor(el: HTMLAudioElement) {
    this.el = el;
  }

  /**
   * Position in ms within the audio currently playing.
   *
   * Rebased on attach so that resubscribing (a reconnect, an avatar taking over
   * the audio) restarts the timeline at zero rather than inheriting the
   * previous source's position.
   */
  get positionMs(): number {
    if (this.source === "none") return 0;
    return Math.max(0, this.el.currentTime * 1000 - this.attachedAtMs);
  }

  get playing(): boolean {
    return this.source !== "none" && !this.el.paused && !this.el.ended;
  }

  get kind(): ClockSource {
    return this.source;
  }

  markAttached(source: ClockSource): void {
    this.source = source;
    this.attachedAtMs = source === "none" ? 0 : this.el.currentTime * 1000;
  }

  detach(): void {
    this.source = "none";
    this.attachedAtMs = 0;
  }
}
