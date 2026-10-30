// The recommended offset for a song: what Better Arrow Vortex's sync map would fix ("Fix offset"),
// measured on the games' timeline (MP3 lead-in included), so it is the offset Etterna needs.
//
// That measurement looks ±60 ms around the beats, and in fast music with an attack on every 16th
// note (54-79 ms apart at 190-280 BPM) a chart more than ~40 ms off gets matched to the 16th
// next to its beat, confidently and wrongly. So the attacks are also summed over the whole song
// out to ±100 ms: when another place there is nearly as strong as the chosen one, the beat could
// be either, and each is offered as a choice instead of one answer.

import { BEAT_AFTER_ONSET_PEAK, type OnsetCurve } from './analysis/sharpOnsets';
import { fitSync } from './analysis/syncFix';
import { beatColumns, localOffsets, songBeats, type LocalOffset } from './analysis/syncMap';
import { decodeForGames } from './analysis/mp3Lead';
import { TempoMap } from './model/timing';
import type { TimingData } from './model/types';

/** How far around each beat the whole-song sum and the picture reach (ms). */
export const WIDE_MS = 100;
export const WIDE_ROWS = 2 * WIDE_MS + 1;
/** Another place at least this strong (relative to the chosen one) makes the answer uncertain. */
export const RIVAL_STRENGTH = 0.8;
/** Places closer than this are the same attack (ms). */
const SAME_PLACE_MS = 10;

export interface Choice {
  offset: number;
  /** How far the music's attacks are after the beats now (ms), i.e. how much the offset moves. */
  shiftMs: number;
  /** The middle 80% of the clear stretches after this fix, in ms around 0. */
  spread: [number, number];
  used: number;
  /** How strong the attacks there are over the whole song, relative to the strongest place. */
  strength: number;
}

export interface Recommendation {
  current: number;
  /** The recommended fix first; more than one when the beat could be at another place too. */
  choices: Choice[];
  /** The sync along the song (every 8 beats) as first measured. */
  points: LocalOffset[];
  /** For the picture: each beat's onsets from −WIDE_MS to +WIDE_MS, scaled to its own maximum. */
  beats: number[];
  columns: Float32Array;
  duration: number;
}

/** The sharp onset curve of the whole song (mixed to mono), computed in a worker. */
function sharpOnsetsOf(buffer: AudioBuffer): Promise<OnsetCurve> {
  const samples = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; ++c) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; ++i) samples[i] += d[i] / buffer.numberOfChannels;
  }
  const worker = new Worker(new URL('./analysis/syncWorker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<{ curve?: OnsetCurve; error?: string }>) => {
      worker.terminate();
      if (e.data.curve) resolve(e.data.curve);
      else reject(new Error(e.data.error ?? 'The onset analysis failed.'));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage({ samples, sampleRate: buffer.sampleRate }, [samples.buffer]);
  });
}

/** The curve at time t (linearly interpolated, 0 outside it). */
function at(c: OnsetCurve, t: number): number {
  const p = (t - c.start) / c.step;
  const i = Math.floor(p);
  if (i < 0 || i + 1 >= c.env.length) return 0;
  return c.env[i] + (c.env[i + 1] - c.env[i]) * (p - i);
}

/** Each beat's onsets out to ±WIDE_MS (scaled per beat, for the picture), and their sum over the song. */
export function wideColumns(curve: OnsetCurve, beats: readonly number[]): { columns: Float32Array; profile: Float64Array } {
  const columns = new Float32Array(beats.length * WIDE_ROWS);
  const profile = new Float64Array(WIDE_ROWS);
  const col = new Float32Array(WIDE_ROWS);
  beats.forEach((t, i) => {
    let max = 0;
    for (let k = 0; k < WIDE_ROWS; ++k) {
      col[k] = at(curve, t - BEAT_AFTER_ONSET_PEAK + (k - WIDE_MS) / 1000);
      profile[k] += col[k];
      max = Math.max(max, col[k]);
    }
    if (max > 0) for (let k = 0; k < WIDE_ROWS; ++k) columns[i * WIDE_ROWS + k] = col[k] / max;
  });
  return { columns, profile };
}

/** The whole-song sum, lightly smoothed, as heights above its typical level, and its peaks (strongest first). */
export function profileShape(profile: Float64Array): { heightAt: (ms: number) => number; peaks: { ms: number; height: number }[] } {
  const n = profile.length;
  const smooth = profile.map((_, k) => (profile[Math.max(0, k - 1)] + profile[k] + profile[Math.min(n - 1, k + 1)]) / 3);
  const base = [...smooth].sort((a, b) => a - b)[Math.floor(n / 2)];
  const heightAt = (ms: number) => {
    const p = Math.min(n - 1, Math.max(0, ms + WIDE_MS));
    const i = Math.min(n - 2, Math.floor(p));
    return Math.max(0, smooth[i] + (smooth[i + 1] - smooth[i]) * (p - i) - base);
  };
  const peaks: { ms: number; height: number }[] = [];
  for (let k = 3; k < n - 3; ++k) {
    let top = true;
    for (let j = Math.max(0, k - SAME_PLACE_MS); j <= Math.min(n - 1, k + SAME_PLACE_MS) && top; ++j) if (smooth[j] > smooth[k]) top = false;
    if (top && smooth[k] > base) peaks.push({ ms: k - WIDE_MS, height: smooth[k] - base });
  }
  return { heightAt, peaks: peaks.sort((a, b) => b.height - a.height) };
}

/** The fix that puts the beats on the attacks found around `nearMs` (measured as the sync map does). */
function fixNear(timing: TimingData, curve: OnsetCurve, duration: number, nearMs: number): { choice: Omit<Choice, 'strength'>; points: LocalOffset[] } | null {
  const moved = { ...timing, offset: timing.offset - nearMs / 1000 };
  const beats = songBeats(new TempoMap(moved), duration);
  const points = localOffsets(beatColumns(curve, beats).raw, beats);
  const fix = fitSync(moved, points, 'offset');
  if ('error' in fix) return null;
  // The stretches relative to where this fix puts the beats.
  const typical = (moved.offset - fix.offset) * 1000;
  const after = points.flatMap((p) => (p.offset === null ? [] : [p.offset - typical])).sort((a, b) => a - b);
  const q = (f: number) => after[Math.min(after.length - 1, Math.floor(f * after.length))];
  return { choice: { offset: fix.offset, shiftMs: (timing.offset - fix.offset) * 1000, spread: [q(0.1), q(0.9)], used: fix.used }, points };
}

/** The fix around `nearMs`, measured again centred on what it found (the sync map's window pulls answers near its edge inwards). */
function settledFixNear(timing: TimingData, curve: OnsetCurve, duration: number, nearMs: number): ReturnType<typeof fixNear> {
  const first = fixNear(timing, curve, duration, nearMs);
  if (!first || Math.abs(first.choice.shiftMs - nearMs) < 2) return first;
  return fixNear(timing, curve, duration, first.choice.shiftMs) ?? first;
}

/** The recommendation from the song's onset curve (separate from decoding, for tests). */
export function recommendFromCurve(timing: TimingData, curve: OnsetCurve, duration: number): Recommendation | { error: string } {
  const beats = songBeats(new TempoMap(timing), duration);
  const { columns, profile } = wideColumns(curve, beats);
  const { heightAt, peaks } = profileShape(profile);

  // The sync map's answer, or, when it finds nothing within ±60 ms, the strongest place further out.
  const here = fixNear(timing, curve, duration, 0);
  const first = here ? settledFixNear(timing, curve, duration, here.choice.shiftMs) : peaks.length ? settledFixNear(timing, curve, duration, peaks[0].ms) : null;
  if (!first) return { error: 'Too few clear attacks on the beats to go by: check the BPM first.' };
  const points = here?.points ?? [];
  const found: Omit<Choice, 'strength'>[] = [first.choice];
  const mainHeight = heightAt(first.choice.shiftMs);
  // Other places nearly as strong (or stronger) could be the beat as well.
  for (const p of peaks) {
    if (found.length >= 3) break;
    if (p.height < RIVAL_STRENGTH * mainHeight || found.some((c) => Math.abs(c.shiftMs - p.ms) <= SAME_PLACE_MS)) continue;
    const alt = settledFixNear(timing, curve, duration, p.ms);
    if (alt && !found.some((c) => Math.abs(c.shiftMs - alt.choice.shiftMs) <= SAME_PLACE_MS)) found.push(alt.choice);
  }
  // Strongest first: where the attacks pile up most over the whole song is the likeliest beat.
  const top = Math.max(...found.map((c) => heightAt(c.shiftMs)), ...peaks.map((p) => p.height), 1e-9);
  const choices = found.map((c) => ({ ...c, strength: heightAt(c.shiftMs) / top })).sort((a, b) => b.strength - a.strength);
  return { current: timing.offset, choices, points, beats, columns, duration };
}

export async function recommendOffset(timing: TimingData, music: ArrayBuffer): Promise<Recommendation | { error: string }> {
  const buffer = await decodeForGames(new OfflineAudioContext(1, 1, 44100), music);
  const curve = await sharpOnsetsOf(buffer);
  return recommendFromCurve(timing, curve, buffer.duration);
}
