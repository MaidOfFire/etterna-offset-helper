import { describe, expect, it } from 'vitest';
import { BEAT_AFTER_ONSET_PEAK, type OnsetCurve } from '../src/analysis/sharpOnsets';
import { emptyTiming, type TimingData } from '../src/model/types';
import { recommendFromCurve } from '../src/recommend';

const BPM = 200;
const BEAT = 60 / BPM;
const SIXTEENTH = BEAT / 4; // 75 ms
const SECONDS = 60;

/** An onset curve with an attack on every beat and weaker ones on the 16ths between, in sync with offset 0. */
function music(sixteenths: number): OnsetCurve {
  const step = 0.00145;
  const env = new Float32Array(Math.round(SECONDS / step));
  for (let n = 0; n * SIXTEENTH < SECONDS; ++n) {
    const peak = n * SIXTEENTH - BEAT_AFTER_ONSET_PEAK;
    const height = n % 4 === 0 ? 1 : sixteenths;
    for (let i = Math.max(0, Math.floor((peak - 0.01) / step)); i < env.length && i * step < peak + 0.01; ++i) {
      env[i] += height * Math.exp(-(((i * step - peak) / 0.002) ** 2));
    }
  }
  return { env, start: 0, step };
}

const timing = (offset: number): TimingData => ({ ...emptyTiming(), offset, bpms: [{ beat: 0, bpm: BPM }] });

describe('the recommended offset and when it is unsure', () => {
  it('gives one answer when the beats clearly stand out', () => {
    const rec = recommendFromCurve(timing(0), music(0.4), SECONDS);
    if ('error' in rec) throw new Error(rec.error);
    expect(rec.choices).toHaveLength(1);
    expect(Math.abs(rec.choices[0].shiftMs)).toBeLessThan(1);
  });

  it('offers the 16th note too when it is nearly as strong as the beat', () => {
    const rec = recommendFromCurve(timing(0), music(0.9), SECONDS);
    if ('error' in rec) throw new Error(rec.error);
    expect(rec.choices.length).toBeGreaterThan(1);
    expect(Math.abs(rec.choices[0].shiftMs)).toBeLessThan(1);
    expect(rec.choices.slice(1).some((c) => Math.abs(Math.abs(c.shiftMs) - SIXTEENTH * 1000) < 2)).toBe(true);
  });

  it('finds a chart 70 ms off instead of settling on the 16th next to its beats', () => {
    // Beats 70 ms early: the sync map's ±60 ms window sees only the 16th 5 ms before them.
    const rec = recommendFromCurve(timing(0.07), music(0.5), SECONDS);
    if ('error' in rec) throw new Error(rec.error);
    expect(rec.choices[0].shiftMs).toBeCloseTo(70, 0);
    expect(rec.choices[0].offset).toBeCloseTo(0, 3);
    expect(rec.choices.some((c) => Math.abs(c.shiftMs + 5) < 2)).toBe(true);
  });
});
