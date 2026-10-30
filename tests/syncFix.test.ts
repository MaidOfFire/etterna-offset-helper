import { describe, expect, it } from 'vitest';
import { fitSync } from '../src/analysis/syncFix';
import type { LocalOffset } from '../src/analysis/syncMap';
import { TempoMap } from '../src/model/timing';
import type { TimingData } from '../src/model/types';

const timing = (bpms: [number, number][], offset = 0, warps: TimingData['warps'] = []): TimingData => ({
  offset,
  bpms: bpms.map(([beat, bpm]) => ({ beat, bpm })),
  stops: [],
  delays: [],
  warps,
  timeSigs: [],
  labels: [],
  extra: [],
});

/** Measurements every 8 beats from beat 4: how late the music is (ms) at each beat. */
function measure(t: TimingData, lastBeat: number, late: (beat: number) => number): LocalOffset[] {
  const tempo = new TempoMap(t);
  const out: LocalOffset[] = [];
  for (let b = 4; b <= lastBeat; b += 8) out.push({ time: tempo.beatToTime(b), offset: late(b) });
  return out;
}

describe('fixing sync from the sync map', () => {
  it('moves the whole grid by the typical difference, ignoring a stray measurement', () => {
    const t = timing([[0, 120]]);
    const m = measure(t, 200, () => 20);
    m[5].offset = 55; // a misread stretch
    const fix = fitSync(t, m, 'offset');
    if ('error' in fix) throw new Error(fix.error);
    expect(fix.offset).toBeCloseTo(-0.02, 6);
    expect(fix.bpms).toEqual([120]);
  });

  it('sets each BPM marker so its beats land on the music, keeping the markers on their beats', () => {
    // 10 ms late throughout the 120 BPM part; in the 150 BPM part (from beat 64) the music drifts
    // to 30 ms late by beat 192: that part is a little slower than charted.
    const t = timing([[0, 120], [64, 150]]);
    const late = (b: number) => (b < 64 ? 10 : 10 + (20 * (b - 64)) / 128);
    const fix = fitSync(t, measure(t, 192, late), 'bpms');
    if ('error' in fix) throw new Error(fix.error);
    expect(fix.offset).toBeCloseTo(-0.01, 4);
    expect(fix.bpms[0]).toBeCloseTo(120, 3);
    expect(fix.bpms[1]).toBeLessThan(150);
    // In the fixed timing every beat sits where the music is (to half a millisecond).
    const before = new TempoMap(t);
    const after = new TempoMap({ ...t, offset: fix.offset, bpms: t.bpms.map((b, i) => ({ beat: b.beat, bpm: fix.bpms[i] })) });
    for (const b of [0, 32, 64, 128, 192]) expect((after.beatToTime(b) - before.beatToTime(b)) * 1000).toBeCloseTo(late(b), 0);
  });

  it('leaves the BPMs of a chart with warps alone', () => {
    const t = timing([[0, 120]], 0, [{ beat: 16, length: 4 }]);
    expect(fitSync(t, measure(t, 100, () => 5), 'bpms')).toHaveProperty('error');
  });
});
