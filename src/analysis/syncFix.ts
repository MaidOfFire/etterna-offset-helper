// Copied from Better Arrow Vortex (src/analysis/syncFix.ts).
// Fixing sync from the sync map's measurements (syncMap.ts): moving the chart's beats onto the
// music's attacks without moving or adding any marker. Either the offset alone (the whole grid
// shifts by the typical difference), or the offset and the value of every BPM marker: the
// correction is fitted as a line bending only at the markers' beats, so each marker keeps its beat
// and only how fast its section runs changes. Notes stay on their beats and move with them.

import { TempoMap } from '../model/timing';
import type { TimingData } from '../model/types';
import type { LocalOffset } from './syncMap';

export interface SyncFix {
  offset: number;
  /** The new value of each BPM marker, in order (their beats stay). */
  bpms: number[];
  /** The largest difference left (ms), and where (seconds): what moving markers cannot fix. */
  worst: { ms: number; time: number };
  /** Measurements used (spikes are left out). */
  used: number;
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Clear measurements, as beats of the current grid, without spikes (off their neighbours' median by over 8 ms). */
function cleanMeasurements(tempo: TempoMap, measured: readonly LocalOffset[]): { beat: number; time: number; ms: number }[] {
  const clear = measured.filter((m): m is { time: number; offset: number } => m.offset !== null);
  return clear
    .filter((m, i) => {
      const near = clear.slice(Math.max(0, i - 2), i + 3).map((n) => n.offset);
      return Math.abs(m.offset - median(near)) <= 8;
    })
    .map((m) => ({ beat: tempo.timeToBeat(m.time), time: m.time, ms: m.offset }));
}

/** Solves a symmetric tridiagonal system (diagonal, off-diagonal, right-hand side). */
function solveTridiagonal(diag: Float64Array, off: Float64Array, rhs: Float64Array): Float64Array {
  const n = diag.length;
  const c = new Float64Array(n);
  const d = new Float64Array(n);
  c[0] = n > 1 ? off[0] / diag[0] : 0;
  d[0] = rhs[0] / diag[0];
  for (let i = 1; i < n; ++i) {
    const m = diag[i] - off[i - 1] * c[i - 1];
    c[i] = i < n - 1 ? off[i] / m : 0;
    d[i] = (rhs[i] - off[i - 1] * d[i - 1]) / m;
  }
  const x = new Float64Array(n);
  x[n - 1] = d[n - 1];
  for (let i = n - 2; i >= 0; --i) x[i] = d[i] - c[i] * x[i + 1];
  return x;
}

/**
 * The fix for the given measurements, or a reason it cannot be made: `offset` moves the whole
 * grid by the typical difference; `bpms` also sets every BPM marker's value so the correction may
 * change along the song (straight between markers, bending at them).
 */
export function fitSync(timing: TimingData, measured: readonly LocalOffset[], mode: 'offset' | 'bpms'): SyncFix | { error: string } {
  const tempo = new TempoMap(timing);
  const points = cleanMeasurements(tempo, measured);
  if (points.length < 4) return { error: 'Too few clear attacks on the beats to go by: check the BPM first.' };
  const bpmsNow = timing.bpms.map((b) => b.bpm);

  if (mode === 'offset') {
    const typical = median(points.map((p) => p.ms));
    const worst = points.reduce((w, p) => (Math.abs(p.ms - typical) > w.ms ? { ms: Math.abs(p.ms - typical), time: p.time } : w), { ms: 0, time: 0 });
    return { offset: timing.offset - typical / 1000, bpms: bpmsNow, worst, used: points.length };
  }
  if (timing.warps.length) return { error: 'The chart has warps: fix its BPMs by hand (the offset alone can still be fixed).' };

  // Knots: every BPM marker's beat, plus the end of the measurements (the last section's pace).
  const knots = timing.bpms.map((b) => b.beat);
  const lastBeat = Math.max(...points.map((p) => p.beat));
  if (lastBeat > knots[knots.length - 1] + 1) knots.push(lastBeat);
  const n = knots.length;
  const segmentOf = (beat: number) => {
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (knots[mid] <= beat) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  // Least squares for the correction at each knot, straight in between, with a light pull towards
  // neighbouring knots (fills sections without measurements) and a robust (Huber) weighting so a
  // few wrong measurements cannot pull it. Corrections are in ms.
  const typical = median(points.map((p) => p.ms));
  const weight = points.map(() => 1);
  let corr: Float64Array = new Float64Array(n).fill(typical);
  const share = (beat: number): [number, number] => {
    const k = segmentOf(beat);
    if (k >= n - 1) return [n - 1, 0];
    return [k, Math.min(1, Math.max(0, (beat - knots[k]) / (knots[k + 1] - knots[k])))];
  };
  const predict = (beat: number) => {
    const [k, u] = share(beat);
    return k >= n - 1 ? corr[n - 1] : corr[k] * (1 - u) + corr[k + 1] * u;
  };
  for (let pass = 0; pass < 4; ++pass) {
    const diag = new Float64Array(n).fill(1e-6);
    const off = new Float64Array(Math.max(1, n - 1));
    const rhs = new Float64Array(n).fill(1e-6 * typical);
    points.forEach((p, i) => {
      const [k, u] = share(p.beat);
      const w = weight[i];
      if (k >= n - 1) {
        diag[n - 1] += w;
        rhs[n - 1] += w * p.ms;
        return;
      }
      diag[k] += w * (1 - u) * (1 - u);
      diag[k + 1] += w * u * u;
      off[k] += w * u * (1 - u);
      rhs[k] += w * (1 - u) * p.ms;
      rhs[k + 1] += w * u * p.ms;
    });
    const smooth = 0.01;
    for (let k = 0; k + 1 < n; ++k) {
      diag[k] += smooth;
      diag[k + 1] += smooth;
      off[k] -= smooth;
    }
    corr = solveTridiagonal(diag, off, rhs);
    points.forEach((p, i) => {
      const r = Math.abs(p.ms - predict(p.beat));
      weight[i] = r <= 4 ? 1 : 4 / r;
    });
  }

  // New values: each section takes as long as its corrected ends say (its stops stay as they are).
  const bpms = timing.bpms.map((b, j) => {
    const next = j + 1 < n ? knots[j + 1] : null;
    if (next === null) return b.bpm; // after the last measurement: nothing to go by
    const span = next - knots[j];
    const now = tempo.beatToTime(next) - tempo.beatToTime(knots[j]);
    const pauses = now - (span * 60) / b.bpm;
    const secondsPerBeat = (now + (corr[j + 1] - corr[j]) / 1000 - pauses) / span;
    return secondsPerBeat > 0 ? 60 / secondsPerBeat : b.bpm;
  });
  const worst = points.reduce((w, p) => {
    const r = Math.abs(p.ms - predict(p.beat));
    return r > w.ms ? { ms: r, time: p.time } : w;
  }, { ms: 0, time: 0 });
  return { offset: timing.offset - corr[0] / 1000, bpms, worst, used: points.length };
}
