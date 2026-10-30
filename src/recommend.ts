// The recommended offset for a song: what Better Arrow Vortex's sync map would fix ("Fix offset"),
// measured on the games' timeline (MP3 lead-in included), so it is the offset Etterna needs.

import type { OnsetCurve } from './analysis/sharpOnsets';
import { fitSync } from './analysis/syncFix';
import { beatColumns, localOffsets, songBeats, type LocalOffset } from './analysis/syncMap';
import { decodeForGames } from './analysis/mp3Lead';
import { TempoMap } from './model/timing';
import type { TimingData } from './model/types';

export interface Recommendation {
  current: number;
  offset: number;
  /** How much the offset moves, in ms (the music's attacks are this much after the beats now). */
  shiftMs: number;
  /** The sync along the song (every 8 beats), and how many of those stretches were clear. */
  points: LocalOffset[];
  used: number;
  /** The middle 80% of the clear stretches after the fix, in ms around 0. */
  spread: [number, number];
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

export async function recommendOffset(timing: TimingData, music: ArrayBuffer): Promise<Recommendation | { error: string }> {
  const buffer = await decodeForGames(new OfflineAudioContext(1, 1, 44100), music);
  const curve = await sharpOnsetsOf(buffer);
  const beats = songBeats(new TempoMap(timing), buffer.duration);
  const points = localOffsets(beatColumns(curve, beats).raw, beats);
  const fix = fitSync(timing, points, 'offset');
  if ('error' in fix) return fix;
  const shiftMs = (timing.offset - fix.offset) * 1000;
  const after = points.flatMap((p) => (p.offset === null ? [] : [p.offset - shiftMs])).sort((a, b) => a - b);
  const at = (q: number) => after[Math.min(after.length - 1, Math.floor(q * after.length))];
  return { current: timing.offset, offset: fix.offset, shiftMs, points, used: fix.used, spread: [at(0.1), at(0.9)], duration: buffer.duration };
}
