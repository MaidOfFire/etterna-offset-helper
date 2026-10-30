// Copied from Better Arrow Vortex (src/model/timing.ts).
// Beat <-> time conversion for a TimingData (BPMs, stops, delays, warps, offset).
//
// The timeline is cut into points where something changes. For every point we store the time we
// arrive at it, the time a note on it is hit (after any delay) and the time we leave it (after any
// stop). Between points time advances at the point's seconds-per-beat, which is 0 inside warps.

import { ROWS_PER_BEAT, type BpmChange, type TimingData } from './types';

const EPS = 1e-9;

export interface TimingPoint {
  beat: number;
  bpm: number;
  warped: boolean;
  arrive: number;
  hit: number;
  leave: number;
}

export interface MeasureSig {
  beat: number;
  /** Measure number at `beat` (fractional when a signature starts mid-measure). */
  measure: number;
  beatsPerMeasure: number;
  num: number;
  den: number;
}

/** Index of the last element whose key is <= value, or -1. */
function lastAtOrBefore<T>(list: readonly T[], value: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = list.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(list[mid]) <= value + EPS) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export class TempoMap {
  readonly points: TimingPoint[] = [];
  readonly sigs: MeasureSig[] = [];
  private readonly bpms: BpmChange[];

  constructor(readonly data: TimingData) {
    const bpms = data.bpms.filter((b) => b.bpm > 0).sort((a, b) => a.beat - b.beat);
    this.bpms = bpms.length ? bpms : [{ beat: 0, bpm: 120 }];

    const beats = new Set<number>([0]);
    for (const b of this.bpms) beats.add(b.beat);
    for (const s of data.stops) beats.add(s.beat);
    for (const s of data.delays) beats.add(s.beat);
    for (const w of data.warps) {
      beats.add(w.beat);
      beats.add(w.beat + w.length);
    }
    const sorted = [...beats].sort((a, b) => a - b);

    let time = 0;
    for (let i = 0; i < sorted.length; ++i) {
      const beat = sorted[i];
      const bpm = this.bpmAt(beat);
      const warped = data.warps.some((w) => w.beat <= beat + EPS && beat < w.beat + w.length - EPS);
      let delay = 0;
      let stop = 0;
      for (const d of data.delays) if (Math.abs(d.beat - beat) < EPS) delay += d.seconds;
      for (const s of data.stops) if (Math.abs(s.beat - beat) < EPS) stop += s.seconds;
      const arrive = time;
      const hit = arrive + delay;
      const leave = hit + stop;
      this.points.push({ beat, bpm, warped, arrive, hit, leave });
      if (i + 1 < sorted.length) time = leave + (warped ? 0 : ((sorted[i + 1] - beat) * 60) / bpm);
    }

    // Shift so that beat 0 is reached at -offset.
    const zero = this.points.find((p) => p.beat === 0)!;
    const shift = -data.offset - zero.arrive;
    for (const p of this.points) {
      p.arrive += shift;
      p.hit += shift;
      p.leave += shift;
    }

    this.buildSigs();
  }

  private buildSigs(): void {
    const list = this.data.timeSigs
      .filter((s) => s.num > 0 && s.den > 0)
      .sort((a, b) => a.beat - b.beat);
    if (!list.length || list[0].beat > 0) list.unshift({ beat: 0, num: 4, den: 4 });
    let measure = 0;
    for (let i = 0; i < list.length; ++i) {
      const s = list[i];
      const beatsPerMeasure = (s.num * 4) / s.den;
      if (i > 0) {
        const prev = this.sigs[i - 1];
        measure = prev.measure + (s.beat - prev.beat) / prev.beatsPerMeasure;
      }
      this.sigs.push({ beat: s.beat, measure, beatsPerMeasure, num: s.num, den: s.den });
    }
  }

  get firstBpm(): number {
    return this.bpms[0].bpm;
  }

  bpmAt(beat: number): number {
    const i = lastAtOrBefore(this.bpms, beat, (b) => b.beat);
    return this.bpms[Math.max(0, i)].bpm;
  }

  beatToTime(beat: number): number {
    const pts = this.points;
    const first = pts[0];
    if (beat < first.beat - EPS) return first.arrive - ((first.beat - beat) * 60) / first.bpm;
    const p = pts[lastAtOrBefore(pts, beat, (q) => q.beat)];
    if (Math.abs(beat - p.beat) < EPS) return p.hit;
    return p.leave + (p.warped ? 0 : ((beat - p.beat) * 60) / p.bpm);
  }

  timeToBeat(time: number): number {
    const pts = this.points;
    const first = pts[0];
    if (time < first.arrive) return first.beat - ((first.arrive - time) * first.bpm) / 60;
    const p = pts[lastAtOrBefore(pts, time, (q) => q.arrive)];
    if (time < p.leave || p.warped) return p.beat;
    return p.beat + ((time - p.leave) * p.bpm) / 60;
  }

  rowToTime(row: number): number {
    return this.beatToTime(row / ROWS_PER_BEAT);
  }

  /** Fractional row at the given time. */
  timeToRow(time: number): number {
    return this.timeToBeat(time) * ROWS_PER_BEAT;
  }

  isWarped(beat: number): boolean {
    return this.data.warps.some((w) => w.beat <= beat + EPS && beat < w.beat + w.length - EPS);
  }

  sigAt(beat: number): MeasureSig {
    return this.sigs[Math.max(0, lastAtOrBefore(this.sigs, beat, (s) => s.beat))];
  }

  beatToMeasure(beat: number): number {
    const s = this.sigAt(beat);
    return s.measure + (beat - s.beat) / s.beatsPerMeasure;
  }

  /** Calls fn for every measure start between the two beats (inclusive of the first). */
  forEachMeasure(beginBeat: number, endBeat: number, fn: (beat: number, measure: number, sig: MeasureSig) => void): void {
    for (let i = 0; i < this.sigs.length; ++i) {
      const s = this.sigs[i];
      const sigEnd = i + 1 < this.sigs.length ? this.sigs[i + 1].beat : Infinity;
      if (sigEnd <= beginBeat) continue;
      if (s.beat > endBeat) break;
      let k = Math.max(0, Math.floor((beginBeat - s.beat) / s.beatsPerMeasure));
      for (;;) {
        const beat = s.beat + k * s.beatsPerMeasure;
        if (beat >= sigEnd - EPS || beat > endBeat) break;
        fn(beat, Math.round((s.measure + k) * 1000) / 1000, s);
        ++k;
      }
    }
  }
}
