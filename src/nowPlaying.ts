// What Etterna is playing. Its themes write nowplaying.txt to the install folder when gameplay
// starts ("Now playing <title> by <artist> in <pack> MSD: 23.45", for stream overlays) and a blank
// line on other screens. The line has no path, but it names the pack folder, so the song is the
// one in that pack whose simfile has that title and artist. Like Etterna, a song folder's .ssc is
// read when it has one, its .sm otherwise.

export interface NowPlaying {
  /** The line as Etterna wrote it. */
  line: string;
  /** Ways to split it into "<title> by <artist>" and the pack (a title may contain " in "). */
  splits: { song: string; pack: string }[];
  msd: number | null;
}

/** The song in nowplaying.txt, or null when Etterna is not in gameplay. */
export function parseNowPlaying(text: string): NowPlaying | null {
  const line = text.trim();
  const m = /^Now playing (.+?)(?: MSD: ([\d.]+))?$/s.exec(line);
  if (!m) return null;
  const rest = m[1];
  const splits: NowPlaying['splits'] = [];
  for (let i = rest.lastIndexOf(' in '); i > 0; i = rest.lastIndexOf(' in ', i - 1)) {
    splits.push({ song: rest.slice(0, i), pack: rest.slice(i + 4) });
  }
  return splits.length ? { line, splits, msd: m[2] ? Number(m[2]) : null } : null;
}

/** The header tags of a simfile (before its charts). */
export function headerTags(text: string): Record<string, string> {
  const end = text.search(/#(NOTES|NOTEDATA)\s*:/i);
  const head = end >= 0 ? text.slice(0, end) : text;
  const tags: Record<string, string> = {};
  for (const m of head.matchAll(/#([A-Z]+)\s*:([^;]*);/gi)) {
    const key = m[1].toUpperCase();
    if (!(key in tags)) tags[key] = m[2].trim();
  }
  return tags;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Whether a simfile's header gives "<title> by <artist>" (main or transliterated names). */
export function songMatches(tags: Record<string, string>, song: string): boolean {
  const want = squash(song);
  const titles = [tags.TITLE, tags.TITLETRANSLIT].filter(Boolean);
  const artists = [tags.ARTIST ?? '', tags.ARTISTTRANSLIT].filter((a) => a !== undefined);
  return titles.some((t) => artists.some((a) => squash(`${t} by ${a}`) === want));
}

/** The simfile Etterna loads from a song folder: the .ssc when there is one, else the .sm. */
export function chosenSimfile(names: readonly string[]): string | null {
  const lower = (n: string) => n.toLowerCase();
  return names.find((n) => lower(n).endsWith('.ssc')) ?? names.find((n) => lower(n).endsWith('.sm')) ?? null;
}

export interface SongFolder {
  pack: string;
  dir: FileSystemDirectoryHandle;
  /** The simfile Etterna loads, and any other simfiles beside it. */
  simfile: string;
  simfiles: string[];
}

async function childDir(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch {
    for await (const [n, h] of parent.entries()) {
      if (h.kind === 'directory' && n.toLowerCase() === name.toLowerCase()) return h as FileSystemDirectoryHandle;
    }
    return null;
  }
}

/** Songs already read, by pack folder: name, simfiles and header tags of each song folder. */
type PackIndex = { dir: FileSystemDirectoryHandle; simfile: string; simfiles: string[]; tags: Record<string, string> }[];
const packCache = new WeakMap<FileSystemDirectoryHandle, PackIndex>();

async function indexPack(pack: FileSystemDirectoryHandle): Promise<PackIndex> {
  const cached = packCache.get(pack);
  if (cached) return cached;
  const index: PackIndex = [];
  for await (const [, h] of pack.entries()) {
    if (h.kind !== 'directory') continue;
    const dir = h as FileSystemDirectoryHandle;
    const names: string[] = [];
    for await (const [n, f] of dir.entries()) if (f.kind === 'file') names.push(n);
    const simfile = chosenSimfile(names);
    if (!simfile) continue;
    const text = await (await dir.getFileHandle(simfile)).getFile().then((f) => f.text());
    index.push({ dir, simfile, simfiles: names.filter((n) => /\.(ssc|sm)$/i.test(n)), tags: headerTags(text) });
  }
  packCache.set(pack, index);
  return index;
}

/** Forgets what was read of a pack (after its files changed). */
export function forgetPack(pack: FileSystemDirectoryHandle): void {
  packCache.delete(pack);
}

/** The song folders matching the line, looking in each songs folder (the install's Songs and any additional ones). */
export async function findSong(np: NowPlaying, songRoots: readonly FileSystemDirectoryHandle[]): Promise<SongFolder[]> {
  const found: SongFolder[] = [];
  for (const { song, pack } of np.splits) {
    for (const root of songRoots) {
      const packDir = await childDir(root, pack);
      if (!packDir) continue;
      for (const s of await indexPack(packDir)) {
        if (songMatches(s.tags, song)) found.push({ pack, dir: s.dir, simfile: s.simfile, simfiles: s.simfiles });
      }
    }
    if (found.length) return found;
  }
  return found;
}
