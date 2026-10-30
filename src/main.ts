// The Etterna offset helper: a page that watches what Etterna plays (nowplaying.txt in its folder),
// measures that song's offset the way Better Arrow Vortex's sync map does ("Fix offset"), and
// writes the fix into the simfile on Apply. Etterna reads the song again with Ctrl+Shift+R on song
// select.

import './style.css';
import { h } from './dom';
import { findFile, firstAudio } from './files';
import { loadSimfile } from './model/simfileIO';
import { findSong, parseNowPlaying, type NowPlaying, type SongFolder } from './nowPlaying';
import { additionalSongFolders, readOffset, withOffset } from './offsetFile';
import { recommendOffset, type Recommendation } from './recommend';
import { loadFolders, saveFolders, type Folders } from './store';

/** Below this the chart counts as in sync (ms). */
const IN_SYNC_MS = 2;
/** A spread wider than this after the fix means the BPMs drift, which the offset cannot fix (ms). */
const WIDE_MS = 10;

interface SongState {
  np: NowPlaying;
  status: 'finding' | 'measuring' | 'ready' | 'error';
  error?: string;
  folder?: SongFolder;
  others?: SongFolder[];
  title?: string;
  artist?: string;
  splitTiming?: boolean;
  rec?: Recommendation;
  applied?: { offset: number; files: string[]; skipped: string[]; kept: number; undo: { name: string; bytes: Uint8Array }[] };
  restored?: boolean;
  busy?: boolean;
}

const baseOf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const ms = (v: number, digits = 1) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)} ms`;
const seconds = (v: number) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(6);

async function readBytes(dir: FileSystemDirectoryHandle, name: string): Promise<Uint8Array> {
  return new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer());
}

async function writeBytes(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void> {
  const w = await (await dir.getFileHandle(name)).createWritable();
  await w.write(bytes as Uint8Array<ArrayBuffer>);
  await w.close();
}

async function hasChild(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  for await (const [n] of dir.entries()) if (n.toLowerCase() === name.toLowerCase()) return true;
  return false;
}

class Helper {
  folders: Folders = { install: null, extra: [] };
  /** Extra song folders listed in Etterna's Preferences.ini. */
  wanted: string[] = [];
  /** Whether the browser lets the page read and write the folders right now. */
  granted = false;
  watch: 'idle' | 'ok' | 'missing' | 'denied' = 'idle';
  inGameplay = false;
  song: SongState | null = null;
  message = '';
  private readonly worker = new Worker(new URL('./watchWorker.ts', import.meta.url), { type: 'module' });
  private run = 0;

  constructor(private readonly root: HTMLElement) {
    this.worker.onmessage = (e: MessageEvent<{ text?: string; error?: string }>) => {
      if (e.data.error) {
        this.watch = e.data.error === 'denied' ? 'denied' : 'missing';
        if (e.data.error === 'denied') this.granted = false;
        this.render();
        return;
      }
      this.watch = 'ok';
      void this.onNowPlaying(e.data.text ?? '');
    };
    window.addEventListener('resize', () => this.render());
    void this.start();
  }

  private async start(): Promise<void> {
    this.folders = await loadFolders();
    if (this.folders.install) this.granted = await this.permitted(false);
    if (this.granted) await this.connected();
    this.render();
  }

  private handles(): FileSystemDirectoryHandle[] {
    return [this.folders.install, ...this.folders.extra.map((f) => f.handle)].filter((d): d is FileSystemDirectoryHandle => d !== null);
  }

  /** Checks (or, after a click, asks for) read and write access to every folder. */
  private async permitted(ask: boolean): Promise<boolean> {
    for (const d of this.handles()) {
      if (!d.queryPermission || !d.requestPermission) continue;
      let state = await d.queryPermission({ mode: 'readwrite' });
      if (state !== 'granted' && ask) state = await d.requestPermission({ mode: 'readwrite' });
      if (state !== 'granted') return false;
    }
    return true;
  }

  /** With access granted: read the extra song folders Etterna uses, and start watching. */
  private async connected(): Promise<void> {
    const install = this.folders.install!;
    try {
      const ini = await (await (await install.getDirectoryHandle('Save')).getFileHandle('Preferences.ini')).getFile();
      this.wanted = additionalSongFolders(await ini.text());
    } catch {
      this.wanted = [];
    }
    this.worker.postMessage({ dir: install });
  }

  async chooseInstall(): Promise<void> {
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await window.showDirectoryPicker!({ mode: 'readwrite', id: 'etterna' });
    } catch {
      return; // cancelled
    }
    if (!(await hasChild(dir, 'Songs')) && !(await hasChild(dir, 'Save'))) {
      this.message = `“${dir.name}” has no Songs or Save folder: choose the folder Etterna is installed in (where Etterna.exe is).`;
      return this.render();
    }
    this.message = '';
    this.folders.install = dir;
    await saveFolders(this.folders);
    this.granted = await this.permitted(true);
    if (this.granted) await this.connected();
    this.render();
  }

  async addSongsFolder(path?: string): Promise<void> {
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await window.showDirectoryPicker!({ mode: 'readwrite', id: 'etterna-songs' });
    } catch {
      return;
    }
    this.message = path && dir.name.toLowerCase() !== baseOf(path).toLowerCase() ? `Added “${dir.name}” for ${path}; its name differs, so check it is the right folder.` : '';
    this.folders.extra = this.folders.extra.filter((f) => f.path !== (path ?? dir.name));
    this.folders.extra.push({ path: path ?? dir.name, handle: dir });
    await saveFolders(this.folders);
    this.render();
    if (this.song?.status === 'error' && this.song.np) void this.measure(this.song.np);
  }

  async removeSongsFolder(path: string): Promise<void> {
    this.folders.extra = this.folders.extra.filter((f) => f.path !== path);
    await saveFolders(this.folders);
    this.render();
  }

  async reconnect(): Promise<void> {
    this.granted = await this.permitted(true);
    if (this.granted) await this.connected();
    this.render();
  }

  private async songRoots(): Promise<FileSystemDirectoryHandle[]> {
    const roots: FileSystemDirectoryHandle[] = [];
    try {
      roots.push(await this.folders.install!.getDirectoryHandle('Songs'));
    } catch {
      // an install without its own Songs folder
    }
    return [...roots, ...this.folders.extra.map((f) => f.handle)];
  }

  private async onNowPlaying(text: string): Promise<void> {
    const np = parseNowPlaying(text);
    this.inGameplay = np !== null;
    if (!np) return this.render();
    // The same song started again: measure again only if its offset changed on disk.
    const s = this.song;
    if (s && s.np.line === np.line && s.folder && s.rec) {
      const now = readOffset(await readBytes(s.folder.dir, s.folder.simfile).catch(() => new Uint8Array()));
      if (now !== null && Math.abs(now - s.rec.current) < 5e-7) return this.render();
    }
    await this.measure(np);
  }

  async measure(np: NowPlaying): Promise<void> {
    const run = ++this.run;
    const song: SongState = { np, status: 'finding' };
    this.song = song;
    this.render();
    const stale = () => run !== this.run;
    try {
      const found = await findSong(np, await this.songRoots());
      if (stale()) return;
      if (!found.length) {
        const where = ['Songs', ...this.folders.extra.map((f) => f.path)].join(', ');
        return this.fail(song, `Could not find this song in ${where}. If it lives in another songs folder, add that folder above.`);
      }
      const [folder, ...others] = found;
      Object.assign(song, { folder, others, status: 'measuring' });
      this.render();
      const text = await (await (await folder.dir.getFileHandle(folder.simfile)).getFile()).text();
      const sim = loadSimfile(text, folder.simfile);
      Object.assign(song, { title: sim.meta.TITLE, artist: sim.meta.ARTIST, splitTiming: sim.charts.some((c) => c.timing) });
      const music = (sim.meta.MUSIC ? await findFile(folder.dir, sim.meta.MUSIC) : null) ?? (await firstAudio(folder.dir));
      if (!music) return this.fail(song, `The music file “${sim.meta.MUSIC}” is not in the song folder.`);
      const rec = await recommendOffset(sim.timing, await music.arrayBuffer());
      if (stale()) return;
      if ('error' in rec) return this.fail(song, rec.error);
      Object.assign(song, { rec, status: 'ready' });
    } catch (e) {
      if (!stale()) return this.fail(song, (e as Error).message);
    }
    this.render();
  }

  private fail(song: SongState, error: string): void {
    Object.assign(song, { status: 'error', error });
    this.render();
  }

  async apply(): Promise<void> {
    const s = this.song;
    if (!s?.folder || !s.rec || s.busy) return;
    s.busy = true;
    this.render();
    const applied: NonNullable<SongState['applied']> = { offset: s.rec.offset, files: [], skipped: [], kept: 0, undo: [] };
    try {
      for (const name of s.folder.simfiles) {
        const bytes = await readBytes(s.folder.dir, name);
        const edit = withOffset(bytes, s.rec.offset);
        // A simfile whose offset is not the one measured (changed meanwhile, or a different file) stays.
        if (!edit || Math.abs(edit.old - s.rec.current) > 5e-7) {
          applied.skipped.push(name);
          continue;
        }
        await writeBytes(s.folder.dir, name, edit.bytes);
        applied.undo.push({ name, bytes });
        applied.files.push(name);
        applied.kept += edit.kept;
      }
      s.applied = applied;
      s.restored = false;
    } catch (e) {
      this.message = `Could not save: ${(e as Error).message}`;
    }
    s.busy = false;
    this.render();
  }

  async undo(): Promise<void> {
    const s = this.song;
    if (!s?.folder || !s.applied || s.busy) return;
    s.busy = true;
    try {
      for (const u of s.applied.undo) await writeBytes(s.folder.dir, u.name, u.bytes);
      s.applied = undefined;
      s.restored = true;
    } catch (e) {
      this.message = `Could not restore: ${(e as Error).message}`;
    }
    s.busy = false;
    this.render();
  }

  // ----------------------------------------------------------------------------------------------

  render(): void {
    const s = this.song;
    const rec = s?.status === 'ready' ? s.rec : undefined;
    document.title = rec && s?.title ? `${ms(-rec.shiftMs)} · ${s.title} — Etterna offset helper` : 'Etterna offset helper';
    const parts: (HTMLElement | null)[] = [
      h('header', {}, h('h1', {}, 'Etterna offset helper'), this.watchLine()),
      this.message ? h('p', { class: 'notice' }, this.message) : null,
      this.foldersCard(),
      this.songCard(),
      h(
        'details',
        { class: 'about' },
        h('summary', {}, 'How it works'),
        h(
          'p',
          {},
          'When a song starts, Etterna writes its title, artist and pack to nowplaying.txt in its folder (Til’ Death and Rebirth themes). The helper finds that song, measures where the music’s attacks fall around the chart’s beats, as Better Arrow Vortex’s sync map does, on the timeline Etterna plays (MP3 lead-in included), and recommends the offset that puts them on the beats. ',
          'Apply changes only the #OFFSET value in the song’s simfiles. Etterna’s chart keys do not include the offset, so scores stay with the chart. The player’s global offset is separate and is not touched.',
        ),
      ),
    ];
    this.root.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null));
    const canvas = this.root.querySelector<HTMLCanvasElement>('canvas.strip');
    if (canvas && rec) drawStrip(canvas, rec);
  }

  private watchLine(): HTMLElement {
    let text: string;
    let state = 'off';
    if (!window.showDirectoryPicker) text = 'Needs Chrome or Edge (folder access).';
    else if (!this.folders.install) text = 'Choose the Etterna folder to start.';
    else if (!this.granted) text = 'Paused: the browser needs your OK to read the folders again.';
    else if (this.watch === 'missing') text = 'Waiting for nowplaying.txt: Etterna writes it when a song starts.';
    else if (this.watch === 'ok') [text, state] = [this.inGameplay ? 'Watching: in gameplay' : 'Watching: not in gameplay', 'on'];
    else text = 'Starting…';
    return h('p', { class: `watch ${state}` }, h('span', { class: 'dot' }), text);
  }

  private foldersCard(): HTMLElement {
    const f = this.folders;
    const rows: HTMLElement[] = [
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'label' }, 'Etterna folder'),
        h('span', { class: 'value' }, f.install ? f.install.name : '—'),
        h('button', { type: 'button', onclick: () => void this.chooseInstall() }, f.install ? 'Change…' : 'Choose…'),
      ),
    ];
    const paths = [...new Set([...this.wanted, ...f.extra.map((e) => e.path)])];
    for (const path of paths) {
      const added = f.extra.find((e) => e.path === path);
      const listed = this.wanted.includes(path);
      rows.push(
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'label' }, listed ? 'Songs folder' : 'Added folder'),
          h('span', { class: 'value', title: path }, path, added && added.handle.name !== baseOf(path) ? ` (${added.handle.name})` : null),
          added
            ? h('button', { type: 'button', class: 'quiet', onclick: () => void this.removeSongsFolder(path), title: 'Stop looking in this folder' }, 'Remove')
            : h('button', { type: 'button', onclick: () => void this.addSongsFolder(path) }, 'Add…'),
        ),
      );
    }
    const missing = this.wanted.filter((p) => !f.extra.some((e) => e.path === p));
    return h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Folders'),
      ...rows,
      f.install && this.granted && missing.length
        ? h('p', { class: 'hint' }, 'Etterna also loads songs from the folders above (from its Preferences.ini). Web pages cannot open a folder by its path, so add each one once.')
        : null,
      h(
        'div',
        { class: 'actions' },
        f.install && !this.granted ? h('button', { type: 'button', class: 'primary', onclick: () => void this.reconnect() }, 'Allow access') : null,
        f.install ? h('button', { type: 'button', class: 'quiet', onclick: () => void this.addSongsFolder() }, 'Add another songs folder…') : null,
      ),
    );
  }

  private songCard(): HTMLElement | null {
    const s = this.song;
    if (!s) {
      return this.folders.install && this.granted
        ? h('section', { class: 'card empty' }, h('p', {}, 'Play a song in Etterna: its recommended offset shows here.'))
        : null;
    }
    const where = s.folder ? `${s.folder.pack} / ${s.folder.dir.name}` : s.np.splits[0].pack;
    const head = h(
      'div',
      { class: 'song-head' },
      h('h2', {}, s.title ?? s.np.splits[0].song),
      h('p', { class: 'meta' }, [s.artist, where, s.np.msd !== null ? `MSD ${s.np.msd.toFixed(2)}` : null].filter(Boolean).join(' · ')),
    );
    if (s.status === 'finding' || s.status === 'measuring') {
      return h('section', { class: 'card' }, head, h('p', { class: 'working' }, s.status === 'finding' ? 'Finding the song…' : 'Measuring the sync…'));
    }
    if (s.status === 'error' || !s.rec) return h('section', { class: 'card' }, head, h('p', { class: 'error' }, s.error ?? 'Something went wrong.'));
    const rec = s.rec;
    const change = -rec.shiftMs;
    const inSync = Math.abs(change) < IN_SYNC_MS;
    const wide = rec.spread[1] - rec.spread[0] > 2 * WIDE_MS;
    const music = `The music comes ${Math.abs(rec.shiftMs).toFixed(1)} ms ${rec.shiftMs < 0 ? 'before' : 'after'} the chart’s beats`;
    const a = s.applied;
    return h(
      'section',
      { class: 'card' },
      head,
      h(
        'div',
        { class: 'offsets' },
        h('div', {}, h('span', { class: 'label' }, 'Offset now'), h('span', { class: 'num' }, seconds(rec.current))),
        h('div', {}, h('span', { class: 'label' }, 'Recommended'), h('span', { class: `num ${inSync ? '' : 'accent'}` }, seconds(rec.offset))),
        h('div', {}, h('span', { class: 'label' }, 'Change'), h('span', { class: `num ${inSync ? '' : 'accent'}` }, ms(change))),
      ),
      h(
        'p',
        { class: 'summary' },
        inSync ? `In sync: within ${IN_SYNC_MS} ms, nothing to fix. ` : `${music}. `,
        `Measured from ${rec.used} clear stretches of 8 beats; after the fix the middle 80% of them sit within ${ms(rec.spread[0])} … ${ms(rec.spread[1])}.`,
      ),
      wide ? h('p', { class: 'warn' }, 'The sync wanders along the song, so one offset cannot fix all of it: the BPMs may need fixing (Fix offset + BPMs in Better Arrow Vortex’s Adjust sync).') : null,
      s.splitTiming ? h('p', { class: 'warn' }, 'Some charts have their own timing. Their offsets move only where they equal the song’s.') : null,
      h('canvas', { class: 'strip', title: 'The sync along the song: each dot is 8 beats. Dashed: where the fix puts the beats.' }),
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', class: inSync ? '' : 'primary', disabled: s.busy || (a && Math.abs(a.offset - rec.offset) < 5e-7), onclick: () => void this.apply() }, a ? 'Applied' : 'Apply offset'),
        a ? h('button', { type: 'button', class: 'quiet', disabled: s.busy, onclick: () => void this.undo() }, 'Undo') : null,
      ),
      a
        ? h(
            'p',
            { class: 'done' },
            a.files.length ? `Saved ${seconds(a.offset)} to ${a.files.join(', ')}. In Etterna, on song select with this song selected, press Ctrl+Shift+R to reload it.` : 'Nothing saved: the simfiles’ offset changed since it was measured. Play the song again to measure it anew.',
            a.skipped.length && a.files.length ? ` Left alone (different offset): ${a.skipped.join(', ')}.` : '',
            a.kept ? ` ${a.kept} chart offset${a.kept === 1 ? '' : 's'} kept (different from the song’s).` : '',
          )
        : s.restored
          ? h('p', { class: 'done' }, 'Restored the previous offset. Press Ctrl+Shift+R in Etterna to reload it.')
          : null,
      s.others?.length ? h('p', { class: 'hint' }, `Also found in: ${s.others.map((o) => `${o.pack} / ${o.dir.name}`).join(', ')} (not changed).`) : null,
    );
  }
}

/** The sync along the song: a dot per clear stretch (later is up), 0 where the beats are now, dashed where the fix puts them. */
function drawStrip(canvas: HTMLCanvasElement, rec: Recommendation): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const hgt = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(hgt * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(canvas);
  const color = (name: string) => css.getPropertyValue(name).trim();
  // Scaled to the bulk of the song; the odd stretch further out sits on the edge.
  const range = Math.max(20, Math.abs(rec.shiftMs) + 2.5 * Math.max(Math.abs(rec.spread[0]), Math.abs(rec.spread[1])));
  const y = (v: number) => hgt / 2 - (Math.max(-range, Math.min(range, v)) / range) * (hgt / 2 - 6);
  ctx.strokeStyle = color('--border');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(y(0)) + 0.5);
  ctx.lineTo(w, Math.round(y(0)) + 0.5);
  ctx.stroke();
  ctx.strokeStyle = color('--accent');
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, Math.round(y(rec.shiftMs)) + 0.5);
  ctx.lineTo(w, Math.round(y(rec.shiftMs)) + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color('--text');
  for (const p of rec.points) {
    if (p.offset === null) continue;
    ctx.beginPath();
    ctx.arc((p.time / rec.duration) * w, y(p.offset), 2.2, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.fillStyle = color('--muted');
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText(`music later ${ms(range, 0)}`, 4, 12);
  ctx.fillText(`earlier ${ms(-range, 0)}`, 4, hgt - 4);
}

const helper = new Helper(document.getElementById('helper')!);
// Handy for debugging and for scripting from the console.
(window as unknown as { helper: Helper }).helper = helper;
