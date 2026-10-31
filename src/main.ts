// The Etterna offset helper: a page that watches what Etterna plays (nowplaying.txt in its folder),
// measures that song's offset the way Better Arrow Vortex's sync map does ("Fix offset"), and
// writes the fix into the simfile on Apply. Etterna reads the song again with Ctrl+Shift+R on song
// select. It also answers the in-game part it can install into Til' Death (see game.ts).

import './style.css';
import { h } from './dom';
import { findChild, findFile, firstAudio } from './files';
import { loadSimfile } from './model/simfileIO';
import { GAME_DIR, LOAD_LINE, formatFields, parseRequest, songPath, withLoadLine, withoutLoadLine } from './game';
import { chosenSimfile, findSong, parseNowPlaying, type NowPlaying, type SongFolder } from './nowPlaying';
import themeLua from './theme/offsethelper.lua?raw';
import { additionalSongFolders, readOffset, withOffset } from './offsetFile';
import type { TimingData } from './model/types';
import { WIDE_MS, WIDE_ROWS, analyzeMusic, recommendFromCurve, type Choice, type MusicAnalysis, type Recommendation } from './recommend';
import { loadFolders, saveFolders, type Folders } from './store';

/** Below this the chart counts as in sync (ms). */
const IN_SYNC_MS = 2;
/** A spread wider than this after the fix means the BPMs drift, which the offset cannot fix (ms). */
const DRIFT_MS = 10;

interface SongState {
  /** What started it: the line in nowplaying.txt, or the song folder the in-game part named. */
  np?: NowPlaying;
  gameDir?: string;
  status: 'finding' | 'measuring' | 'ready' | 'error';
  error?: string;
  folder?: SongFolder;
  others?: SongFolder[];
  title?: string;
  artist?: string;
  splitTiming?: boolean;
  rec?: Recommendation;
  /** The song's timing as read and its music, to measure again against an applied offset. */
  timing?: TimingData;
  music?: MusicAnalysis;
  /** The sync with the applied offset, which the map then shows (centred when the fix was right). */
  after?: Recommendation;
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
  /** Extra song folders listed in Etterna's Preferences.ini, and why it could not be read. */
  wanted: string[] = [];
  prefsError: string | null = null;
  /** Whether the browser lets the page read and write the folders right now. */
  granted = false;
  watch: 'idle' | 'ok' | 'missing' | 'denied' = 'idle';
  inGameplay = false;
  song: SongState | null = null;
  message = '';
  /** The in-game part in Til' Death: not looked for yet, absent, installed, or installed but older than this page's. */
  game: { state: 'unknown' | 'absent' | 'installed' | 'outdated' | 'unavailable'; theme?: string; note?: string } = { state: 'unknown' };
  private readonly worker = new Worker(new URL('./watchWorker.ts', import.meta.url), { type: 'module' });
  private run = 0;
  private lastRequest = '';

  constructor(private readonly root: HTMLElement) {
    this.worker.onmessage = (e: MessageEvent<{ text?: string; error?: string; request?: string }>) => {
      if (e.data.request !== undefined) {
        void this.onRequest(e.data.request);
        return;
      }
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

  /** Checks (or, after a click, asks for) read and write access to every folder (and reading a chosen Preferences.ini). */
  private async permitted(ask: boolean): Promise<boolean> {
    const wants: [FileSystemHandle, 'read' | 'readwrite'][] = this.handles().map((d) => [d, 'readwrite']);
    if (this.folders.prefsFile) wants.push([this.folders.prefsFile, 'read']);
    if (this.folders.nowPlayingFile) wants.push([this.folders.nowPlayingFile, 'read']);
    for (const [d, mode] of wants) {
      if (!d.queryPermission || !d.requestPermission) continue;
      let state = await d.queryPermission({ mode });
      if (state !== 'granted' && ask) state = await d.requestPermission({ mode });
      if (state !== 'granted') return false;
    }
    return true;
  }

  /** With access granted: read the extra song folders Etterna uses, and start watching. */
  private async connected(): Promise<void> {
    await this.readPrefs();
    await this.checkGame();
    this.worker.postMessage({ dir: this.folders.install!, nowPlaying: this.folders.nowPlayingFile });
  }

  /**
   * Etterna's extra song folders, from Save/Preferences.ini in its folder (or the file chosen by
   * hand). On failure the reason is kept to show, and it is tried again with the next song.
   */
  private async readPrefs(): Promise<void> {
    try {
      let file = this.folders.prefsFile ?? null;
      if (!file) {
        const save = await findChild(this.folders.install!, 'Save', 'directory');
        if (!save) throw new Error('there is no Save folder in it');
        file = await findChild(save, 'Preferences.ini', 'file');
        if (!file) throw new Error('its Save folder has no Preferences.ini');
      }
      this.wanted = additionalSongFolders(await (await file.getFile()).text());
      this.prefsError = null;
    } catch (e) {
      this.prefsError = e instanceof DOMException ? `${e.name}: ${e.message}` : (e as Error).message;
    }
  }

  async choosePrefs(): Promise<void> {
    let file: FileSystemFileHandle;
    try {
      [file] = await window.showOpenFilePicker!({ id: 'etterna-prefs', startIn: this.folders.install ?? undefined, types: [{ description: 'Etterna preferences', accept: { 'text/plain': ['.ini'] } }] });
    } catch {
      return; // cancelled
    }
    this.folders.prefsFile = file;
    await saveFolders(this.folders);
    await this.readPrefs();
    this.render();
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
    if (this.song?.status === 'error' && this.song.np) void this.measure({ np: this.song.np });
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
    if (s && s.np?.line === np.line && s.folder && s.rec) {
      const now = readOffset(await readBytes(s.folder.dir, s.folder.simfile).catch(() => new Uint8Array()));
      if (now !== null && Math.abs(now - s.rec.current) < 5e-7) return this.render();
    }
    await this.measure({ np });
  }

  /** Measures a song: the one in nowplaying.txt (looked up by title), or a song folder the in-game part named. */
  async measure(target: { np: NowPlaying } | { folder: SongFolder; gameDir: string }): Promise<SongState> {
    const run = ++this.run;
    const song: SongState = 'np' in target ? { np: target.np, status: 'finding' } : { gameDir: target.gameDir, status: 'finding' };
    this.song = song;
    this.render();
    const stale = () => run !== this.run;
    if (this.prefsError) await this.readPrefs();
    try {
      const found = 'np' in target ? await findSong(target.np, await this.songRoots()) : [target.folder];
      if (stale()) return song;
      if (!found.length) {
        const where = ['Songs', ...this.folders.extra.map((f) => f.path)].join(', ');
        this.fail(song, `Could not find this song in ${where}. If it lives in another songs folder, add that folder above.`);
        return song;
      }
      const [folder, ...others] = found;
      Object.assign(song, { folder, others, status: 'measuring' });
      this.render();
      const text = await (await (await folder.dir.getFileHandle(folder.simfile)).getFile()).text();
      const sim = loadSimfile(text, folder.simfile);
      Object.assign(song, { title: sim.meta.TITLE, artist: sim.meta.ARTIST, splitTiming: sim.charts.some((c) => c.timing) });
      const music = (sim.meta.MUSIC ? await findFile(folder.dir, sim.meta.MUSIC) : null) ?? (await firstAudio(folder.dir));
      if (!music) {
        this.fail(song, `The music file “${sim.meta.MUSIC}” is not in the song folder.`);
        return song;
      }
      const analysis = await analyzeMusic(await music.arrayBuffer());
      if (stale()) return song;
      const rec = recommendFromCurve(sim.timing, analysis.curve, analysis.duration);
      if ('error' in rec) {
        this.fail(song, rec.error);
        return song;
      }
      Object.assign(song, { rec, timing: sim.timing, music: analysis, status: 'ready' });
    } catch (e) {
      if (!stale()) this.fail(song, (e as Error).message);
      return song;
    }
    this.render();
    return song;
  }

  // ----------------------------------------------------------------------------------------------
  // The in-game part (theme/offsethelper.lua): its requests, and installing it into Til' Death.

  /** A request from the game, answered in OffsetHelper/result.txt (after a quick "busy" so it knows the page is there). */
  private async onRequest(text: string): Promise<void> {
    const req = parseRequest(text);
    if (!req || req.id === this.lastRequest || !this.granted) return;
    this.lastRequest = req.id;
    const id = req.id;
    try {
      await this.answer({ id, status: 'busy' });
      if (req.action === 'measure') {
        const folder = await this.folderOf(req.dir);
        if (typeof folder === 'string') return await this.answer({ id, status: 'error', message: folder });
        const s = await this.measure({ folder, gameDir: req.dir });
        if (s.status !== 'ready' || !s.rec) return await this.answer({ id, status: 'error', message: s.error ?? 'could not measure it' });
        const rec = s.rec;
        const choices: Record<string, string> = {};
        rec.choices.forEach((c, i) => (choices[`choice${i + 1}`] = `${c.offset.toFixed(6)} ${(-c.shiftMs >= 0 ? '+' : '') + (-c.shiftMs).toFixed(1)}`));
        const sure = rec.choices.length === 1;
        return await this.answer({
          id,
          status: 'ready',
          current: rec.current.toFixed(6),
          sure: sure ? 1 : 0,
          insync: sure && Math.abs(rec.choices[0].shiftMs) < IN_SYNC_MS ? 1 : 0,
          ...choices,
          map: await this.writeMap(rec, id),
        });
      }
      const s = this.song;
      if (!s?.rec || s.gameDir !== req.dir) return await this.answer({ id, status: 'error', message: 'press Sync first' });
      if (req.action === 'apply') {
        const choice = s.rec.choices[(req.choice ?? 1) - 1];
        if (!choice) return await this.answer({ id, status: 'error', message: 'no such choice' });
        await this.apply(choice);
        if (!s.applied?.files.length) return await this.answer({ id, status: 'error', message: this.message || 'the offset in the file changed: press Sync again' });
        return await this.answer({ id, status: 'applied', offset: choice.offset.toFixed(6), map: s.after ? await this.writeMap(s.after, id) : undefined });
      }
      await this.undo();
      return await this.answer({ id, status: 'restored', map: await this.writeMap(s.rec, id) });
    } catch (e) {
      await this.answer({ id, status: 'error', message: (e as Error).message }).catch(() => undefined);
    }
  }

  private async gameDir(): Promise<FileSystemDirectoryHandle> {
    return this.folders.install!.getDirectoryHandle(GAME_DIR, { create: true });
  }

  private async answer(fields: Record<string, string | number | undefined>): Promise<void> {
    const dir = await this.gameDir();
    const w = await (await dir.getFileHandle('result.txt', { create: true })).createWritable();
    await w.write(formatFields(fields));
    await w.close();
  }

  /** The sync map as a PNG for the game (shown over the banner, 384×120 there), and its path as Etterna sees it. */
  private async writeMap(rec: Recommendation, id: string): Promise<string> {
    const canvas = document.createElement('canvas');
    drawMap(canvas, rec, 384, 120, 2);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not draw the map'))), 'image/png'));
    const dir = await this.gameDir();
    const name = `map-${id}.png`;
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(blob);
    await w.close();
    // Older maps go; the one before stays, as the game may still show it.
    const maps: string[] = [];
    for await (const [n, h] of dir.entries()) if (h.kind === 'file' && /^map-\d+\.png$/.test(n) && n !== name) maps.push(n);
    maps.sort();
    for (const n of maps.slice(0, -1)) await dir.removeEntry(n).catch(() => undefined);
    return `/${GAME_DIR}/${name}`;
  }

  /** A song folder as Etterna names it (/Songs/Pack/Song/ or /AdditionalSongs/Pack/Song/), or why it was not found. */
  private async folderOf(gameDir: string): Promise<SongFolder | string> {
    const p = songPath(gameDir);
    if (!p) return `not a song folder: ${gameDir}`;
    const roots = p.root === 'Songs' ? (await this.songRoots()).slice(0, this.folders.extra.length ? -this.folders.extra.length : undefined) : this.folders.extra.map((f) => f.handle);
    if (p.root === 'AdditionalSongs' && !roots.length) return 'this song is in an extra songs folder: add it on the helper page';
    for (const root of roots) {
      const pack = await findChild(root, p.pack, 'directory');
      const dir = pack && (await findChild(pack, p.song, 'directory'));
      if (!dir) continue;
      const names: string[] = [];
      for await (const [n, h] of dir.entries()) if (h.kind === 'file') names.push(n);
      const simfile = chosenSimfile(names);
      if (simfile) return { pack: p.pack, dir, simfile, simfiles: names.filter((n) => /\.(ssc|sm)$/i.test(n)) };
    }
    return p.root === 'AdditionalSongs' ? 'not found in the extra songs folders added on the helper page' : 'not found in Songs';
  }

  /** Til' Death's song select decorations folder, or why it is not there. */
  private async decorations(): Promise<{ theme: string; dir: FileSystemDirectoryHandle } | string> {
    const themes = await findChild(this.folders.install!, 'Themes', 'directory');
    if (!themes) return 'there is no Themes folder in the Etterna folder';
    const names: string[] = [];
    for await (const [n, h] of themes.entries()) if (h.kind === 'directory' && /^til'?\s*death$/i.test(n)) names.push(n);
    const theme = names.find((n) => n === 'Til Death') ?? names[0];
    if (!theme) return "Til' Death is not in the Themes folder";
    const bg = await findChild(await themes.getDirectoryHandle(theme), 'BGAnimations', 'directory');
    const dir = bg && (await findChild(bg, 'ScreenSelectMusic decorations', 'directory'));
    if (!dir || !(await findChild(dir, 'default.lua', 'file'))) return `Themes/${theme} has no BGAnimations/ScreenSelectMusic decorations/default.lua`;
    return { theme, dir };
  }

  private async checkGame(): Promise<void> {
    try {
      const d = await this.decorations();
      if (typeof d === 'string') return void (this.game = { state: 'unavailable', note: d });
      const lua = await findChild(d.dir, 'offsethelper.lua', 'file');
      const main = await (await d.dir.getFileHandle('default.lua')).getFile().then((f) => f.text());
      if (!lua || !main.includes(LOAD_LINE)) return void (this.game = { state: 'absent', theme: d.theme });
      const same = (await (await lua.getFile()).text()) === themeLua;
      this.game = { state: same ? 'installed' : 'outdated', theme: d.theme };
    } catch (e) {
      this.game = { state: 'unavailable', note: (e as Error).message };
    }
  }

  /** Puts offsethelper.lua into Til' Death and loads it from its song select (the original file is kept in OffsetHelper/backup). */
  async installGame(): Promise<void> {
    try {
      const d = await this.decorations();
      if (typeof d === 'string') throw new Error(d);
      const mainFile = await d.dir.getFileHandle('default.lua');
      const original = await (await mainFile.getFile()).text();
      const patched = withLoadLine(original);
      if (patched === null) throw new Error(`Themes/${d.theme}/…/default.lua does not end with "return t" as expected, so it was left alone`);
      const ours = await (await d.dir.getFileHandle('offsethelper.lua', { create: true })).createWritable();
      await ours.write(themeLua);
      await ours.close();
      const game = await this.gameDir();
      if (patched !== original) {
        const backups = await game.getDirectoryHandle('backup', { create: true });
        if (!(await findChild(backups, 'default.lua', 'file'))) {
          const b = await (await backups.getFileHandle('default.lua', { create: true })).createWritable();
          await b.write(original);
          await b.close();
        }
        const w = await mainFile.createWritable();
        await w.write(patched);
        await w.close();
      }
      for (const name of ['request.txt', 'result.txt']) await game.getFileHandle(name, { create: true });
      this.message = `Installed into Themes/${d.theme}. Restart Etterna to see the Offset line above the banner on song select, and keep this page open while you play.`;
    } catch (e) {
      this.message = `Could not install: ${(e as Error).message}`;
    }
    await this.checkGame();
    this.render();
  }

  /** Takes the line out of Til' Death's song select and removes offsethelper.lua. */
  async uninstallGame(): Promise<void> {
    try {
      const d = await this.decorations();
      if (typeof d === 'string') throw new Error(d);
      const mainFile = await d.dir.getFileHandle('default.lua');
      const text = await (await mainFile.getFile()).text();
      if (text.includes(LOAD_LINE)) {
        const w = await mainFile.createWritable();
        await w.write(withoutLoadLine(text));
        await w.close();
      }
      await d.dir.removeEntry('offsethelper.lua').catch(() => undefined);
      this.message = `Removed from Themes/${d.theme}. Restart Etterna for it to go.`;
    } catch (e) {
      this.message = `Could not uninstall: ${(e as Error).message}`;
    }
    await this.checkGame();
    this.render();
  }

  private fail(song: SongState, error: string): void {
    Object.assign(song, { status: 'error', error });
    this.render();
  }

  async apply(choice: Choice): Promise<void> {
    const s = this.song;
    if (!s?.folder || !s.rec || s.busy) return;
    // Another choice after one was applied: start from the file as it was.
    if (s.applied) await this.undo();
    s.busy = true;
    this.render();
    const applied: NonNullable<SongState['applied']> = { offset: choice.offset, files: [], skipped: [], kept: 0, undo: [] };
    try {
      for (const name of s.folder.simfiles) {
        const bytes = await readBytes(s.folder.dir, name);
        const edit = withOffset(bytes, choice.offset);
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
      // Measured again with the new offset, so the map shows the music around the new beats.
      if (applied.files.length && s.timing && s.music) {
        const after = recommendFromCurve({ ...s.timing, offset: choice.offset }, s.music.curve, s.music.duration);
        s.after = 'error' in after ? undefined : after;
      }
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
      s.after = undefined;
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
    const tag = rec && (rec.choices.length > 1 ? '?' : ms(-rec.choices[0].shiftMs));
    document.title = tag && s?.title ? `${tag} · ${s.title} — Etterna offset helper` : 'Etterna offset helper';
    const parts: (HTMLElement | null)[] = [
      h('header', {}, h('h1', {}, 'Etterna offset helper'), this.watchLine()),
      this.message ? h('p', { class: 'notice' }, this.message) : null,
      this.foldersCard(),
      this.gameCard(),
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
    const canvas = this.root.querySelector<HTMLCanvasElement>('canvas.map');
    if (canvas && rec) drawMap(canvas, s?.after ?? rec, canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
  }

  /** For themes that write the now-playing line elsewhere: watch the file picked by hand (or nowplaying.txt again). */
  async chooseNowPlaying(reset = false): Promise<void> {
    if (reset) delete this.folders.nowPlayingFile;
    else {
      try {
        [this.folders.nowPlayingFile] = await window.showOpenFilePicker!({ id: 'etterna-nowplaying', startIn: this.folders.install ?? undefined, types: [{ description: 'Now-playing text', accept: { 'text/plain': ['.txt'] } }] });
      } catch {
        return; // cancelled
      }
    }
    await saveFolders(this.folders);
    this.watch = 'idle';
    this.worker.postMessage({ dir: this.folders.install!, nowPlaying: this.folders.nowPlayingFile });
    this.render();
  }

  private watchLine(): HTMLElement {
    let text: string;
    let state = 'off';
    if (!window.showDirectoryPicker) text = 'Needs Chrome or Edge (folder access).';
    else if (!this.folders.install) text = 'Choose the Etterna folder to start.';
    else if (!this.granted) text = 'Paused: the browser needs your OK to read the folders again.';
    else if (this.watch === 'missing') text = `Waiting for ${this.folders.nowPlayingFile?.name ?? 'nowplaying.txt'}: the theme writes it when a song starts.`;
    else if (this.watch === 'ok') [text, state] = [this.inGameplay ? 'Watching: in gameplay' : 'Watching: not in gameplay', 'on'];
    else text = 'Starting…';
    const chosen = this.folders.nowPlayingFile;
    // Some themes write the now-playing line elsewhere: it can be picked by hand.
    const pick =
      this.granted && window.showOpenFilePicker && (chosen || this.watch === 'missing')
        ? h(
            'span',
            { class: 'watch-file' },
            chosen ? `(${chosen.name}) ` : null,
            h('button', { type: 'button', class: 'link', onclick: () => void this.chooseNowPlaying() }, chosen ? 'Change…' : 'Choose the now-playing file…'),
            chosen ? h('button', { type: 'button', class: 'link', onclick: () => void this.chooseNowPlaying(true) }, 'Use nowplaying.txt') : null,
          )
        : null;
    return h('p', { class: `watch ${state}` }, h('span', { class: 'dot' }), text, pick);
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
        ? h('p', { class: 'hint' }, 'Etterna also loads songs from the folders above (listed in its Save/Preferences.ini). Web pages cannot open a folder by its path, so add each one once.')
        : null,
      f.install && this.granted && this.prefsError
        ? h(
            'div',
            { class: 'prefs-problem' },
            h('p', { class: 'warn' }, `Could not read Save/Preferences.ini in “${f.install.name}” (${this.prefsError}), so Etterna’s extra song folders (AdditionalSongFolders) are not listed. Choose the file by hand, or add the folders with “Add another songs folder…”.`),
            window.showOpenFilePicker ? h('button', { type: 'button', onclick: () => void this.choosePrefs() }, 'Choose Preferences.ini…') : null,
          )
        : null,
      h(
        'div',
        { class: 'actions' },
        f.install && !this.granted ? h('button', { type: 'button', class: 'primary', onclick: () => void this.reconnect() }, 'Allow access') : null,
        f.install ? h('button', { type: 'button', class: 'quiet', onclick: () => void this.addSongsFolder() }, 'Add another songs folder…') : null,
      ),
    );
  }

  private gameCard(): HTMLElement | null {
    if (!this.folders.install || !this.granted) return null;
    const g = this.game;
    const what = 'An Offset line above the banner on song select: Sync measures the selected song, Apply writes the offset and reloads the song, and hovering the result shows the sync map over the banner. This page does the measuring, so keep it open while you play.';
    const button = (label: string, onclick: () => void, primary = false) => h('button', { type: 'button', class: primary ? 'primary' : '', onclick }, label);
    const status =
      g.state === 'installed'
        ? `Installed in Themes/${g.theme}.`
        : g.state === 'outdated'
          ? `Installed in Themes/${g.theme}, from an older version of this page.`
          : g.state === 'absent'
            ? `Not installed. Install adds offsethelper.lua to Themes/${g.theme} and one line to its song select; the original file is kept in OffsetHelper/backup.`
            : g.state === 'unavailable'
              ? `Cannot install: ${g.note}.`
              : 'Looking for Til’ Death…';
    return h(
      'section',
      { class: 'card' },
      h('h2', {}, 'In game (Til’ Death)'),
      h('p', { class: 'hint' }, what),
      h('p', { class: g.state === 'unavailable' ? 'warn' : '' }, status),
      h(
        'div',
        { class: 'actions' },
        g.state === 'absent' ? button('Install into Til’ Death', () => void this.installGame(), true) : null,
        g.state === 'outdated' ? button('Update', () => void this.installGame(), true) : null,
        g.state === 'installed' || g.state === 'outdated' ? button('Uninstall', () => void this.uninstallGame()) : null,
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
    const where = s.folder ? `${s.folder.pack} / ${s.folder.dir.name}` : (s.np?.splits[0].pack ?? s.gameDir ?? '');
    const head = h(
      'div',
      { class: 'song-head' },
      h('h2', {}, s.title ?? s.np?.splits[0].song ?? s.folder?.dir.name ?? ''),
      h('p', { class: 'meta' }, [s.artist, where, s.np?.msd != null ? `MSD ${s.np.msd.toFixed(2)}` : null, s.gameDir ? 'asked in game' : null].filter(Boolean).join(' · ')),
    );
    if (s.status === 'finding' || s.status === 'measuring') {
      return h('section', { class: 'card' }, head, h('p', { class: 'working' }, s.status === 'finding' ? 'Finding the song…' : 'Measuring the sync…'));
    }
    if (s.status === 'error' || !s.rec) return h('section', { class: 'card' }, head, h('p', { class: 'error' }, s.error ?? 'Something went wrong.'));
    const rec = s.rec;
    const a = s.applied;
    const sure = rec.choices.length === 1;
    const best = rec.choices[0];
    const inSync = sure && Math.abs(best.shiftMs) < IN_SYNC_MS;
    const drift = best.spread[1] - best.spread[0] > 2 * DRIFT_MS;
    const music = `The music comes ${Math.abs(best.shiftMs).toFixed(1)} ms ${best.shiftMs < 0 ? 'before' : 'after'} the chart’s beats`;
    const applyButton = (c: Choice, label: string, primary: boolean) => {
      const done = a !== undefined && Math.abs(a.offset - c.offset) < 5e-7;
      return h('button', { type: 'button', class: primary && !done ? 'primary' : '', disabled: s.busy || done, onclick: () => void this.apply(c) }, done ? 'Applied' : label);
    };
    const choiceRows = rec.choices.map((c, i) =>
      h(
        'div',
        { class: 'choice' },
        h('span', { class: 'mark' }, String(i + 1)),
        h('span', { class: 'num' }, ms(-c.shiftMs)),
        h('span', { class: 'num muted' }, seconds(c.offset)),
        h('span', { class: 'bar', title: `Attacks there over the whole song: ${Math.round(c.strength * 100)}% of the strongest place` }, h('span', { style: `width:${Math.round(c.strength * 100)}%` })),
        applyButton(c, 'Apply', i === 0),
      ),
    );
    return h(
      'section',
      { class: 'card' },
      head,
      sure
        ? h(
            'div',
            { class: 'offsets' },
            h('div', {}, h('span', { class: 'label' }, 'Offset now'), h('span', { class: 'num' }, seconds(rec.current))),
            h('div', {}, h('span', { class: 'label' }, 'Recommended'), h('span', { class: `num ${inSync ? '' : 'accent'}` }, seconds(best.offset))),
            h('div', {}, h('span', { class: 'label' }, 'Change'), h('span', { class: `num ${inSync ? '' : 'accent'}` }, ms(-best.shiftMs))),
          )
        : h('div', { class: 'offsets' }, h('div', {}, h('span', { class: 'label' }, 'Offset now'), h('span', { class: 'num' }, seconds(rec.current)))),
      sure
        ? h(
            'p',
            { class: 'summary' },
            inSync ? `In sync: within ${IN_SYNC_MS} ms, nothing to fix. ` : `${music}. `,
            `Measured from ${best.used} clear stretches of 8 beats; after the fix the middle 80% of them sit within ${ms(best.spread[0])} … ${ms(best.spread[1])}.`,
          )
        : h(
            'p',
            { class: 'warn' },
            'Not sure where the beat is: the music has strong attacks at more than one place near the chart’s beats (often a 16th note apart, or the chart is more than 40 ms off), and either could be the beat. ',
            'The bright lines in the map below are those places. Try 1 in Etterna; if it feels a 16th note off, apply 2.',
          ),
      sure ? null : h('div', { class: 'choices' }, ...choiceRows),
      drift && sure ? h('p', { class: 'warn' }, 'The sync wanders along the song, so one offset cannot fix all of it: the BPMs may need fixing (Fix offset + BPMs in Better Arrow Vortex’s Adjust sync).') : null,
      s.splitTiming ? h('p', { class: 'warn' }, 'Some charts have their own timing. Their offsets move only where they equal the song’s.') : null,
      h('canvas', { class: 'map', title: 'The sync map: the music’s attacks around each beat along the song (up is later). Blue: the chart’s beats now. Cyan: measured. Dashed: where each choice puts the beats.' }),
      s.after
        ? h('p', { class: 'legend' }, `With the applied offset ${seconds(a!.offset)}: up to ${mapRange(s.after)} ms either side of the new beats, up is later. Blue: the new beats; cyan: measured${s.after.choices.length > 1 ? '; dashed: other places the beat could be' : ''}.`)
        : h('p', { class: 'legend' }, `Up to ${mapRange(rec)} ms either side of the beats along the song, up is later. Blue: the chart’s beats now; cyan: measured; dashed: ${sure ? 'where the fix puts them' : 'the choices'}.`),
      sure ? h('div', { class: 'actions' }, applyButton(best, 'Apply offset', !inSync), a ? h('button', { type: 'button', class: 'quiet', disabled: s.busy, onclick: () => void this.undo() }, 'Undo') : null) : null,
      !sure && a ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'quiet', disabled: s.busy, onclick: () => void this.undo() }, 'Undo')) : null,
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

/** How far the map reaches (ms): the editor's ±60 when the answer is sure and close, ±WIDE_MS when there are choices to show. */
function mapRange(rec: Recommendation): number {
  return rec.choices.length === 1 && Math.abs(rec.choices[0].shiftMs) <= 45 ? 60 : WIDE_MS;
}

/**
 * The sync map, drawn as Better Arrow Vortex's Adjust sync draws it: one pixel column per slice
 * of the song (the beats in it averaged, or else the last beat before it), bright where the
 * music's attacks are around the chart's beats, later at the top.
 */
function drawMap(canvas: HTMLCanvasElement, rec: Recommendation, w: number, hgt: number, dpr: number): void {
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(hgt * dpr));
  canvas.width = pw;
  canvas.height = ph;
  const ctx = canvas.getContext('2d')!;
  const pixels = ctx.createImageData(pw, ph);
  const px = pixels.data;
  const range = mapRange(rec);
  const rowOf = new Int32Array(ph);
  for (let y = 0; y < ph; ++y) rowOf[y] = WIDE_MS - range + Math.round(2 * range * (1 - (y + 0.5) / ph));
  const column = new Float32Array(WIDE_ROWS);
  let b = 0;
  for (let x = 0; x < pw; ++x) {
    const t1 = ((x + 1) / pw) * rec.duration;
    column.fill(0);
    let n = 0;
    while (b < rec.beats.length && rec.beats[b] < t1) {
      for (let k = 0; k < WIDE_ROWS; ++k) column[k] += rec.columns[b * WIDE_ROWS + k];
      ++n;
      ++b;
    }
    if (!n && b > 0 && t1 - rec.beats[b - 1] < 2) {
      for (let k = 0; k < WIDE_ROWS; ++k) column[k] = rec.columns[(b - 1) * WIDE_ROWS + k];
      n = 1;
    }
    for (let y = 0; y < ph; ++y) {
      const v = n ? column[rowOf[y]] / n : 0;
      const g = Math.round(18 + 237 * v * v);
      const i = (y * pw + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = g;
      px[i + 3] = 255;
    }
  }
  ctx.putImageData(pixels, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const xOf = (t: number) => (t / rec.duration) * w;
  const yOf = (v: number) => hgt / 2 - (v / range) * (hgt / 2);

  // Reference lines, as in the editor: ±10 / ±30 ms (±25 / ±50 / ±75 on the wider map).
  ctx.font = '9px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const v of range === 60 ? [-30, -10, 10, 30] : [-75, -50, -25, 25, 50, 75]) {
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(0, Math.round(yOf(v)), w, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText(`${v > 0 ? '+' : '−'}${Math.abs(v)}`, 3, yOf(v));
  }
  ctx.fillStyle = 'rgba(74,143,217,0.75)';
  ctx.fillRect(0, Math.round(yOf(0)), w, 1);

  // Where each choice puts the beats.
  ctx.strokeStyle = 'rgba(255,170,40,0.9)';
  ctx.fillStyle = 'rgba(255,170,40,0.95)';
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1;
  rec.choices.forEach((c, i) => {
    const y = Math.round(yOf(c.shiftMs)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(14, y);
    ctx.lineTo(w - 14, y);
    ctx.stroke();
    if (rec.choices.length > 1) ctx.fillText(String(i + 1), w - 10, y);
  });
  ctx.setLineDash([]);

  // The measured sync over every 8 beats, where it is clear.
  ctx.strokeStyle = 'rgba(90,209,255,0.9)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let drawing = false;
  for (const o of rec.points) {
    if (o.offset === null) {
      drawing = false;
      continue;
    }
    const [x, y] = [xOf(o.time), yOf(o.offset)];
    if (drawing) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    drawing = true;
  }
  ctx.stroke();
}

const helper = new Helper(document.getElementById('helper')!);
// Handy for debugging and for scripting from the console.
(window as unknown as { helper: Helper }).helper = helper;
