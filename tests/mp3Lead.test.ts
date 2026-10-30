import { describe, expect, it } from 'vitest';
import { gameLeadIn, readMp3Header } from '../src/analysis/mp3Lead';

/**
 * The start of an MP3: optionally an ID3v2 tag, then two 128 kbps 44.1 kHz stereo frames, the
 * first carrying an Info/Xing header (frame count, bytes, seek table, quality) and an encoder tag.
 */
function mp3(tag: 'Info' | 'Xing' | null, encoder = 'LAME3.100', frames = 1000, id3 = 0): ArrayBuffer {
  const FRAME = 417; // 144 * 128000 / 44100
  const b = new Uint8Array(id3 + 2 * FRAME);
  if (id3) {
    b.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, (id3 - 10) >> 7, (id3 - 10) & 0x7f]);
  }
  for (const p of [id3, id3 + FRAME]) b.set([0xff, 0xfb, 0x90, 0x00], p);
  if (tag) {
    let q = id3 + 4 + 32;
    const put = (s: string) => {
      for (const c of s) b[q++] = c.charCodeAt(0);
    };
    put(tag);
    b.set([0, 0, 0, 0x0f], q);
    q += 4;
    b.set([frames >> 24, (frames >> 16) & 0xff, (frames >> 8) & 0xff, frames & 0xff], q);
    q += 4 + 4 + 100 + 4;
    put(encoder);
    // Delay 576, padding 1000, 21 bytes into the encoder tag.
    b.set([576 >> 4, ((576 & 15) << 4) | (1000 >> 8), 1000 & 0xff], q - 9 + 21);
  }
  return b.buffer;
}

const RATE = 44100;
const seconds = (samples: number) => samples / RATE;

describe('MP3 lead-in the games play', () => {
  it('reads the frame and the LAME tag behind an ID3 tag', () => {
    expect(readMp3Header(mp3('Info', 'LAME3.100', 5863, 300))).toEqual({ rate: RATE, frameSamples: 1152, tag: 'Info', frames: 5863, delay: 576 });
  });

  it('puts back the Info frame and the lead-in the browser cut', () => {
    const h = readMp3Header(mp3('Info'))!;
    // The browser kept the frames minus the encoder delay and the decoder's 529 samples.
    expect(gameLeadIn(h, seconds(1000 * 1152 - 1105))).toBeCloseTo(seconds(1152 + 1105), 9);
    // A browser that kept the lead-in: only the Info frame is missing.
    expect(gameLeadIn(h, seconds(1000 * 1152))).toBeCloseTo(seconds(1152), 9);
  });

  it('skips Xing frames like the games do', () => {
    const h = readMp3Header(mp3('Xing'))!;
    expect(gameLeadIn(h, seconds(1000 * 1152 - 1105 - 471))).toBeCloseTo(seconds(1105), 9);
  });

  it('adds nothing when no LAME tag says how long the lead-in is', () => {
    expect(gameLeadIn(readMp3Header(mp3('Xing', 'Xing enc '))!, seconds(1000 * 1152))).toBe(0);
    expect(gameLeadIn(readMp3Header(mp3(null))!, 1)).toBe(0);
  });

  it('leaves other formats alone', () => {
    const ogg = new Uint8Array(2000);
    ogg.set([0x4f, 0x67, 0x67, 0x53]);
    expect(readMp3Header(ogg.buffer)).toBeNull();
  });
});
