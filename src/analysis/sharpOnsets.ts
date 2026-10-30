// The sharp onset curve: where the music's attacks are, to a millisecond or two. Copied from
// Better Arrow Vortex (src/analysis/findTempo.ts), which also uses it to find the BPM and offset.

import { fft } from './fft';

/** An onset curve sampled at `start + i * step` seconds. */
export interface OnsetCurve {
  env: Float32Array;
  start: number;
  step: number;
}

/**
 * Onset strength for timing: log spectral flux over ~12 ms windows every ~1.5 ms, each value
 * placed at its window's centre. Too fine to find a tempo with, but it puts attacks within a
 * few milliseconds of where charts put the beat.
 */
export function sharpOnsets(samples: Float32Array, sampleRate: number): OnsetCurve {
  const step = sampleRate > 32000 ? 2 : 1;
  const rate = sampleRate / step;
  const N = 256;
  const H = 32;
  const frames = Math.max(0, Math.floor((Math.floor(samples.length / step) - N) / H));
  const window = new Float32Array(N);
  for (let i = 0; i < N; ++i) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  let prev = new Float32Array(N / 2);
  let cur = new Float32Array(N / 2);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; ++f) {
    const off = f * H * step;
    for (let i = 0; i < N; ++i) {
      let v = 0;
      for (let k = 0; k < step; ++k) v += samples[off + i * step + k];
      re[i] = (v / step) * window[i];
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    for (let k = 1; k < N / 2; ++k) {
      const mag = Math.log1p(100 * Math.hypot(re[k], im[k]));
      cur[k] = mag;
      if (mag > prev[k]) flux += mag - prev[k];
    }
    env[f] = flux;
    [prev, cur] = [cur, prev];
  }
  return { env, start: N / 2 / rate, step: H / rate };
}

/** Charts put the beat this long after the peak of the sharp onset curve (median over 29 songs). */
export const BEAT_AFTER_ONSET_PEAK = 0.0015;
