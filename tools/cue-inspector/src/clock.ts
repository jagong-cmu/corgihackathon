/**
 * The playback clock.
 *
 * Everything in this tool is measured against `HTMLAudioElement.currentTime`
 * and never against wall-clock time. That is the whole point of the harness: a
 * cue is late if it lands after the words it belongs to have been *heard*, and
 * only the audio element knows when that happened. Wall-clock time would hide
 * exactly the failures we are looking for — a stalled or rebuffering track
 * freezes playback while `Date.now()` sails on.
 *
 * Two sources feed the same clock:
 *
 *   - A remote LiveKit audio track, attached via `track.attach()`, which sets
 *     `srcObject` to a MediaStream. For a MediaStream-backed element
 *     `currentTime` is "seconds of audio rendered since playback began" — it
 *     starts at 0 on attach and stalls when the stream stalls, which is the
 *     semantics we want.
 *   - A generated Blob URL, used by the local replay path so the tool is
 *     useful with no LiveKit credentials at all.
 */

export type ClockSource = "none" | "livekit-track" | "local-file";

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
   * Rebased on attach so that swapping the source (subscribe to a new track,
   * load a new fixture) restarts the timeline at zero rather than inheriting
   * the previous source's position.
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

  /** Called by the LiveKit client once the tutor's audio track is attached. */
  markAttached(source: ClockSource): void {
    this.source = source;
    this.attachedAtMs = source === "none" ? 0 : this.el.currentTime * 1000;
  }

  detach(): void {
    this.source = "none";
    this.attachedAtMs = 0;
  }
}
