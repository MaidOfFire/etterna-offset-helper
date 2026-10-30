// Copied from Better Arrow Vortex (src/editor/mp3Lead.ts).
// MP3s start a little later in the games than in the browser. Etterna, StepMania and ArrowVortex
// decode with libmad and keep everything at the start of the file: an "Info" header frame (what
// LAME and ffmpeg write before constant-bitrate audio) plays as one frame of silence, and the
// encoder's lead-in (its delay plus the decoder's 529 samples) plays too. Browsers decode like
// ffmpeg: they skip the header frame and cut the lead-in when a LAME tag says how long it is.
// Charts are timed in the games, so that time goes back in front of the music: for a
// LAME "Info" file at 44.1 kHz that is 51 ms, for a "Xing" (variable bitrate) one 25 ms.

export interface Mp3Header {
  /** The file's sample rate. */
  rate: number;
  /** Samples per frame: 1152 for MPEG-1, 576 for MPEG-2 and 2.5. */
  frameSamples: number;
  /** 'Info' (constant bitrate) or 'Xing' (variable) header frame, or none. */
  tag: 'Info' | 'Xing' | null;
  /** Audio frames after the header frame, when the header says. */
  frames: number | null;
  /** The encoder's delay from a LAME tag (LAME, ffmpeg), which browsers cut along with the decoder's 529 samples. */
  delay: number | null;
}

const DECODER_DELAY = 529;
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/** The Layer III frame header at p: MPEG version bits, rate and frame length in bytes, or null. */
function frameAt(b: Uint8Array, p: number): { version: number; rate: number; bytes: number; mono: boolean } | null {
  if (p + 4 > b.length || b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[p + 1] >> 3) & 3;
  const layer = (b[p + 1] >> 1) & 3;
  const kbpsIndex = b[p + 2] >> 4;
  const rateIndex = (b[p + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || kbpsIndex === 0 || kbpsIndex === 15 || rateIndex === 3) return null;
  const rate = RATES[version][rateIndex];
  const bitrate = (version === 3 ? KBPS_V1 : KBPS_V2)[kbpsIndex] * 1000;
  const bytes = Math.floor(((version === 3 ? 144 : 72) * bitrate) / rate) + ((b[p + 2] >> 1) & 1);
  return { version, rate, bytes, mono: b[p + 3] >> 6 === 3 };
}

const text = (b: Uint8Array, p: number, n: number) => String.fromCharCode(...b.subarray(p, p + n));

/** Reads the start of an MP3 file; null when the data is not one (OGG, WAV, ...). */
export function readMp3Header(data: ArrayBuffer): Mp3Header | null {
  const b = new Uint8Array(data);
  let p = 0;
  // ID3v2 tags in front (there may be several), each with a 10-byte header and maybe a footer.
  while (text(b, p, 3) === 'ID3' && p + 10 <= b.length) {
    const size = ((b[p + 6] & 0x7f) << 21) | ((b[p + 7] & 0x7f) << 14) | ((b[p + 8] & 0x7f) << 7) | (b[p + 9] & 0x7f);
    p += 10 + size + (b[p + 5] & 0x10 ? 10 : 0);
  }
  // The first frame: a header followed by another one right after it.
  const end = Math.min(b.length, p + 65536);
  let first = null;
  for (; p < end; ++p) {
    const f = frameAt(b, p);
    if (f && frameAt(b, p + f.bytes)) {
      first = f;
      break;
    }
  }
  if (!first) return null;
  const header: Mp3Header = { rate: first.rate, frameSamples: first.version === 3 ? 1152 : 576, tag: null, frames: null, delay: null };
  // The Xing/Info header sits after the side information, where the first frame's audio would start.
  const side = first.version === 3 ? (first.mono ? 17 : 32) : first.mono ? 9 : 17;
  let q = p + 4 + side;
  const tag = text(b, q, 4);
  if (tag !== 'Info' && tag !== 'Xing') return header;
  header.tag = tag;
  const flags = (b[q + 4] << 24) | (b[q + 5] << 16) | (b[q + 6] << 8) | b[q + 7];
  q += 8;
  if (flags & 1) {
    header.frames = ((b[q] << 24) | (b[q + 1] << 16) | (b[q + 2] << 8) | b[q + 3]) >>> 0;
    q += 4;
  }
  if (flags & 2) q += 4; // bytes
  if (flags & 4) q += 100; // seek table
  if (flags & 8) q += 4; // quality
  // The LAME tag: encoder name, then 12 bits of delay 21 bytes in. ffmpeg trusts only these encoders.
  if (q + 24 <= b.length && /^(LAME|Lavf|Lavc)/.test(text(b, q, 4))) header.delay = (b[q + 21] << 4) | (b[q + 22] >> 4);
  return header;
}

/**
 * Seconds the games play before the browser's first sample of this file. `decodedSeconds` is the
 * browser's length of it: the lead-in counts only if the browser did cut it (the decoded length
 * falls short of the frames by about that much).
 */
export function gameLeadIn(h: Mp3Header, decodedSeconds: number): number {
  let samples = h.tag === 'Info' ? h.frameSamples : 0;
  if (h.delay !== null) {
    const lead = h.delay + DECODER_DELAY;
    const cut = h.frames === null ? lead : h.frames * h.frameSamples - Math.round(decodedSeconds * h.rate);
    if (cut > lead / 2) samples += lead;
  }
  return samples / h.rate;
}

/** Decodes music as the games play it: an MP3 gets back the silence browsers cut. */
export async function decodeForGames(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  // Read before decoding: decodeAudioData takes the data away.
  const mp3 = readMp3Header(data);
  const decoded = await ctx.decodeAudioData(data);
  const lead = mp3 ? Math.round(gameLeadIn(mp3, decoded.duration) * decoded.sampleRate) : 0;
  if (lead <= 0) return decoded;
  const padded = ctx.createBuffer(decoded.numberOfChannels, decoded.length + lead, decoded.sampleRate);
  for (let c = 0; c < decoded.numberOfChannels; ++c) padded.copyToChannel(decoded.getChannelData(c), c, lead);
  return padded;
}
