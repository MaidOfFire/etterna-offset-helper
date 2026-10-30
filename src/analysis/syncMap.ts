// Copied from Better Arrow Vortex (src/analysis/syncMap.ts).
// The sync map: how the music's attacks sit around each beat of the chart's grid, along the
// whole song. For every beat it takes the sharp onset curve (see findTempo) from 60 ms before
// the beat to 60 ms after; side by side, those columns show a bright line where the attacks are.
// On 0 the chart is in sync there; a line at +30 means the music hits 30 ms after the beats,
// and a line that wanders shows sync that is right in one place and off in another.

import type { TempoMap } from '../model/timing';
import { BEAT_AFTER_ONSET_PEAK, type OnsetCurve } from './sharpOnsets';

/** How far around each beat the map looks, in milliseconds. */
export const SYNC_RANGE_MS = 60;
export const SYNC_ROWS = 2 * SYNC_RANGE_MS + 1;

/** The curve at time t (linearly interpolated, 0 outside it). */
function at(c: OnsetCurve, t: number): number {
  const p = (t - c.start) / c.step;
  const i = Math.floor(p);
  if (i < 0 || i + 1 >= c.env.length) return 0;
  return c.env[i] + (c.env[i + 1] - c.env[i]) * (p - i);
}

/** The times of the chart's whole beats within the song. */
export function songBeats(tempo: TempoMap, duration: number): number[] {
  const beats: number[] = [];
  for (let b = 0; b < 1e6; ++b) {
    const t = tempo.beatToTime(b);
    if (t > duration) break;
    if (t >= 0) beats.push(t);
  }
  return beats;
}

/**
 * One column per beat: row k is the onset strength k − 60 ms from where a beat's attack peaks
 * when the chart is in sync (the beat time minus the calibration). `raw` keeps the strengths;
 * `scaled` divides each column by its highest value, so quiet parts are as readable as loud ones.
 */
export function beatColumns(curve: OnsetCurve, beatTimes: readonly number[]): { raw: Float32Array; scaled: Float32Array } {
  const raw = new Float32Array(beatTimes.length * SYNC_ROWS);
  const scaled = new Float32Array(beatTimes.length * SYNC_ROWS);
  beatTimes.forEach((t, i) => {
    let max = 0;
    for (let k = 0; k < SYNC_ROWS; ++k) {
      const v = at(curve, t - BEAT_AFTER_ONSET_PEAK + (k - SYNC_RANGE_MS) / 1000);
      raw[i * SYNC_ROWS + k] = v;
      max = Math.max(max, v);
    }
    if (max > 0) for (let k = 0; k < SYNC_ROWS; ++k) scaled[i * SYNC_ROWS + k] = raw[i * SYNC_ROWS + k] / max;
  });
  return { raw, scaled };
}

export interface LocalOffset {
  /** Time of the middle of the stretch, in seconds. */
  time: number;
  /** Where the music's attacks are relative to the beats there, in ms (later is positive), or null when unclear. */
  offset: number | null;
}

/**
 * The sync over stretches of `span` beats: the peak of their summed columns, to a fraction of a
 * millisecond. Unclear (null) where that peak does not stand out, e.g. in quiet or beatless parts.
 */
export function localOffsets(raw: Float32Array, beatTimes: readonly number[], span = 8): LocalOffset[] {
  const out: LocalOffset[] = [];
  for (let i = 0; i + span <= beatTimes.length; i += span) {
    const sum = new Float64Array(SYNC_ROWS);
    for (let j = i; j < i + span; ++j) for (let k = 0; k < SYNC_ROWS; ++k) sum[k] += raw[j * SYNC_ROWS + k];
    let k = 0;
    for (let r = 1; r < SYNC_ROWS; ++r) if (sum[r] > sum[k]) k = r;
    const sorted = [...sum].sort((a, b) => a - b);
    const median = sorted[SYNC_RANGE_MS];
    const time = (beatTimes[i] + beatTimes[i + span - 1]) / 2;
    // A clear peak: well above the typical value around it, and not at the edge of the window.
    if (k === 0 || k === SYNC_ROWS - 1 || sum[k] < 1.5 * median) {
      out.push({ time, offset: null });
      continue;
    }
    // Parabola through the peak and its neighbours for the fraction of a millisecond.
    const [a, b, c] = [sum[k - 1], sum[k], sum[k + 1]];
    const frac = a - 2 * b + c < 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
    out.push({ time, offset: k - SYNC_RANGE_MS + frac });
  }
  return out;
}
