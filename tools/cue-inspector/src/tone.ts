/**
 * Synthetic turn audio, shared by the browser's local replay and the Node
 * replay script so both drive the same waveform.
 *
 * The audio is not speech, but it is not silence either: a quiet hum carries
 * the timeline, and every cue time gets a short blip. That makes drift
 * *audible* — if a row's action fires visibly after you hear its blip, the
 * number in the drift column has a sound to go with it.
 *
 * Pure functions, no DOM and no Node APIs, because both runtimes import this.
 */

export const SAMPLE_RATE = 48_000;

export interface TurnAudioSpec {
  durationMs: number;
  /** Cue offsets, in ms from the start of this audio, to mark with a blip. */
  cueMs: readonly number[];
  sampleRate?: number;
}

const HUM_HZ = 110;
const HUM_GAIN = 0.03;
const BLIP_HZ = 880;
const BLIP_GAIN = 0.22;
const BLIP_MS = 60;

/** Mono 16-bit PCM. */
export function renderPcm(spec: TurnAudioSpec): Int16Array {
  const sampleRate = spec.sampleRate ?? SAMPLE_RATE;
  const total = Math.max(1, Math.ceil((spec.durationMs / 1000) * sampleRate));
  const out = new Int16Array(total);

  const blipSamples = Math.round((BLIP_MS / 1000) * sampleRate);
  const cueStarts = spec.cueMs.map((ms) => Math.round((ms / 1000) * sampleRate));

  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    let value = Math.sin(2 * Math.PI * HUM_HZ * t) * HUM_GAIN;

    for (const start of cueStarts) {
      const offset = i - start;
      if (offset >= 0 && offset < blipSamples) {
        // Linear decay so consecutive blips stay distinguishable.
        const envelope = 1 - offset / blipSamples;
        value += Math.sin(2 * Math.PI * BLIP_HZ * (offset / sampleRate)) * BLIP_GAIN * envelope;
      }
    }

    out[i] = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
  }
  return out;
}

/** Wrap mono PCM in a 44-byte RIFF/WAVE header, for `<audio src>`. */
export function wrapWav(pcm: Int16Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const bytesPerSample = 2;
  const dataBytes = pcm.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  new Int16Array(buffer, 44).set(pcm);
  return new Uint8Array(buffer);
}
