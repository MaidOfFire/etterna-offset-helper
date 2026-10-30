import { describe, expect, it } from 'vitest';
import { BEAT_AFTER_ONSET_PEAK } from '../src/analysis/sharpOnsets';
import { SYNC_ROWS, beatColumns, localOffsets } from '../src/analysis/syncMap';

/** An onset curve (1 ms steps) with a sharp attack at each given time. */
function curveWith(attacks: number[], seconds: number) {
  const env = new Float32Array(seconds * 1000).fill(0.1);
  for (const a of attacks) {
    const i = Math.round(a * 1000);
    env[i] = 5;
    env[i - 1] = env[i + 1] = 2;
  }
  return { env, start: 0, step: 0.001 };
}

describe('sync map', () => {
  const beats = Array.from({ length: 64 }, (_, i) => 1 + i * 0.5);
  // The music hits 10 ms after the first 32 beats and 20 ms before the rest.
  const curve = curveWith(beats.map((b, i) => (i < 32 ? b + 0.01 : b - 0.02)), 40);

  it('puts each beat in a column of 121 rows, one per millisecond from -60 to +60', () => {
    const { raw, scaled } = beatColumns(curve, beats);
    expect(raw.length).toBe(64 * SYNC_ROWS);
    // Brightest row of beat 0: 10 ms late, plus the calibration (attacks peak just before the beat).
    const col = Array.from(scaled.subarray(0, SYNC_ROWS));
    // (11.5 ms falls between two rows, which are equally bright.)
    expect(Math.abs(col.indexOf(1) - 60 - (10 + BEAT_AFTER_ONSET_PEAK * 1000))).toBeLessThanOrEqual(0.5);
  });

  it('measures the sync of each stretch of beats, where it is off and by how much', () => {
    const { raw } = beatColumns(curve, beats);
    const offsets = localOffsets(raw, beats);
    expect(offsets).toHaveLength(8);
    const cal = BEAT_AFTER_ONSET_PEAK * 1000;
    for (const o of offsets.slice(0, 4)) expect(o.offset).toBeCloseTo(10 + cal, 0);
    for (const o of offsets.slice(4)) expect(o.offset).toBeCloseTo(-20 + cal, 0);
  });

  it('says nothing where there are no clear attacks', () => {
    const flat = { env: new Float32Array(40000).fill(0.3), start: 0, step: 0.001 };
    const { raw } = beatColumns(flat, beats);
    expect(localOffsets(raw, beats).every((o) => o.offset === null)).toBe(true);
  });
});
