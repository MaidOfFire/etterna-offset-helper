import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// The in-game decoder (native/, built for this computer by native/build.sh as build/oh-cli) on
// MP3s made here with ffmpeg. Skipped without either.
const CLI = 'native/build/oh-cli';
const ffmpeg = spawnSync('ffmpeg', ['-version']);
const ready = existsSync(CLI) && !ffmpeg.error;
const dir = ready ? mkdtempSync(join(tmpdir(), 'oh-native-')) : '';
afterAll(() => dir && rmSync(dir, { recursive: true, force: true }));

function decode(path: string): Float32Array {
  const out = join(dir, 'out.f32');
  const run = spawnSync(CLI, [path, '--dump', out], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr || run.stdout);
  const b = readFileSync(out);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}

/** Byte offsets of the MPEG-1 Layer III frames in a file without tags. */
function frameStarts(b: Uint8Array): number[] {
  const KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const starts: number[] = [];
  for (let p = 0; p + 4 <= b.length; ) {
    if (b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) throw new Error(`no frame at ${p}`);
    starts.push(p);
    p += Math.floor((144 * KBPS[b[p + 2] >> 4] * 1000) / 44100) + ((b[p + 2] >> 1) & 1);
  }
  return starts;
}

describe.skipIf(!ready)('the in-game MP3 decoder', () => {
  it('keeps an MP3 cut without re-encoding on Etterna’s timeline: frames whose data was cut away play as silence', () => {
    // Constant bitrate, no Xing/Info header and no tags: frames from the first byte.
    const full = join(dir, 'full.mp3');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4,volume=0.5', '-af', 'apulsator=hz=3', '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', '-write_xing', '0', '-id3v2_version', '0', '-y', full]);
    expect(made.status, String(made.stderr)).toBe(0);
    const bytes = new Uint8Array(readFileSync(full));
    const starts = frameStarts(bytes);
    const CUT = 40;
    const cut = join(dir, 'cut.mp3');
    writeFileSync(cut, bytes.subarray(starts[CUT]));

    const a = decode(full);
    const b = decode(cut);
    // Every frame left is there (none dropped), so the music stays where it was after the cut.
    expect(b.length).toBe(a.length - CUT * 1152);
    // The frames whose data started before the cut are silent (Etterna, as BASS).
    expect(Math.max(...b.subarray(0, 1152).map(Math.abs))).toBe(0);
    // Past them, the same music at the same place.
    let worst = 0;
    for (let i = 4 * 1152; i < b.length - 1152; ++i) worst = Math.max(worst, Math.abs(b[i] - a[i + CUT * 1152]));
    expect(worst).toBeLessThan(1e-3);
  });
});
