// Changing a simfile's offset in place: only the digits of its #OFFSET tags change, byte for byte,
// so nothing else in the file moves (whatever its text encoding). An .ssc chart with its own
// #OFFSET equal to the song's moves with it; one with a different offset keeps it.

const OFFSET_TAG = /#OFFSET\s*:\s*([^;]*);/gi;

export interface OffsetEdit {
  bytes: Uint8Array;
  /** The song's offset before. */
  old: number;
  /** Chart offsets left as they were because they differ from the song's. */
  kept: number;
}

/** Reads bytes as Latin-1 so that string positions are byte positions. */
const latin1 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
};

/** The song's #OFFSET (the first tag outside comments), or null when it has none. */
export function readOffset(bytes: Uint8Array): number | null {
  const tags = offsetTags(latin1(bytes));
  return tags.length ? tags[0].value : null;
}

function offsetTags(text: string): { start: number; end: number; value: number }[] {
  const out: { start: number; end: number; value: number }[] = [];
  for (const m of text.matchAll(OFFSET_TAG)) {
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    if (text.slice(lineStart, m.index).includes('//')) continue; // commented out
    const value = Number(m[1].trim());
    if (!Number.isFinite(value)) continue;
    const start = m.index + m[0].indexOf(':') + 1;
    out.push({ start, end: m.index + m[0].length - 1, value });
  }
  return out;
}

/** The simfile with its offset set to `offset` (written with 6 decimals, as the games do), or null when it has none. */
export function withOffset(bytes: Uint8Array, offset: number): OffsetEdit | null {
  const text = latin1(bytes);
  const tags = offsetTags(text);
  if (!tags.length) return null;
  const old = tags[0].value;
  const value = new TextEncoder().encode(offset.toFixed(6));
  const change = tags.filter((t, i) => i === 0 || Math.abs(t.value - old) < 1e-7);
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const t of change) {
    parts.push(bytes.subarray(at, t.start), value);
    at = t.end;
  }
  parts.push(bytes.subarray(at));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return { bytes: out, old, kept: tags.length - change.length };
}

/** Etterna's extra song folders from Save/Preferences.ini (full paths as written there). */
export function additionalSongFolders(ini: string): string[] {
  const m = /^AdditionalSongFolders=(.*)$/m.exec(ini);
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}
