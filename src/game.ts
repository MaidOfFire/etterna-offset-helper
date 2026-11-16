// Talking to the in-game part (theme/offsethelper.lua, installed as an overlay screen for every theme). Etterna's Lua
// cannot read audio, so the page does the measuring: the theme writes OffsetHelper/request.txt
// in the Etterna folder ("measure this song", "apply choice 2", "undo") and the page answers in
// OffsetHelper/result.txt, with the sync map as a PNG next to it. Both are `key=value` lines.

/** The folder in the Etterna folder that both sides use. */
export const GAME_DIR = 'OffsetHelper';
/** The line older versions added to a theme's song select (Til' Death's decorations, Rebirth's overlay) to load the in-game part. */
export const LOAD_LINE = 't[#t + 1] = LoadActor("offsethelper")';

export interface GameRequest {
  id: string;
  action: 'measure' | 'apply' | 'undo';
  /** The song folder as Etterna names it, e.g. /Songs/Pack/Song/ or /AdditionalSongs/Pack/Song/. */
  dir: string;
  /** 1-based, for apply. */
  choice?: number;
}

export function parseFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([\w]+)=(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2];
  }
  return fields;
}

export function parseRequest(text: string): GameRequest | null {
  const f = parseFields(text);
  if (!f.id || !f.dir || !['measure', 'apply', 'undo'].includes(f.action)) return null;
  const choice = f.choice ? Number(f.choice) : undefined;
  return { id: f.id, action: f.action as GameRequest['action'], dir: f.dir, choice: choice && choice > 0 ? choice : undefined };
}

/** `key=value` lines (values on one line). */
export function formatFields(fields: Record<string, string | number | undefined>): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, ' ')}`)
    .join('\n') + '\n';
}

/** Which songs folder an Etterna song folder is in, and its pack and song folder names. */
export function songPath(dir: string): { root: 'Songs' | 'AdditionalSongs'; pack: string; song: string } | null {
  const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length !== 3) return null;
  const root = parts[0].toLowerCase() === 'songs' ? 'Songs' : parts[0].toLowerCase() === 'additionalsongs' ? 'AdditionalSongs' : null;
  return root ? { root, pack: parts[1], song: parts[2] } : null;
}

/** A song select file with the in-game part loaded (before its `return t`), or null when it cannot be placed. */
export function withLoadLine(lua: string): string | null {
  if (lua.includes(LOAD_LINE)) return lua;
  const m = /\r?\n(\s*collectgarbage\(\)\s*\r?\n)?\s*return t\s*$/.exec(lua);
  if (!m) return null;
  const eol = lua.includes('\r\n') ? '\r\n' : '\n';
  return lua.slice(0, m.index) + eol + LOAD_LINE + lua.slice(m.index);
}

/** The song select file without the in-game part. */
export function withoutLoadLine(lua: string): string {
  return lua.replace(new RegExp(`\\r?\\n${LOAD_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), '');
}

/**
 * The in-game part as an overlay screen: Etterna draws the screens in [Common] OverlayScreens over
 * every screen, and every theme falls back to _fallback for what it does not set itself. So the
 * screen goes into Themes/_fallback (its section and its name in OverlayScreens), and its name into
 * the OverlayScreens of each theme that has its own list (Rebirth). First in the list: drawn under
 * Etterna's own overlays, and given input first (it takes only clicks on its own line).
 */
export const OVERLAY_SCREEN = 'ScreenOffsetHelper';
/** Its folder in _fallback's BGAnimations (default.lua, which loads offsethelper.lua beside it). */
export const OVERLAY_FOLDER = `${OVERLAY_SCREEN} overlay`;
/** Its metrics section, as Holographic Void defines its own overlay screens. */
export const OVERLAY_SECTION = [
  `[${OVERLAY_SCREEN}]`,
  '# Etterna offset helper (https://maidoffire.github.io/etterna-offset-helper/): its line on song select, in every theme',
  'Class="ScreenWithMenuElementsBasic"',
  'Fallback="Screen"',
  'PlayMusic=false',
  'MusicAlignBeat=false',
  'DelayMusicSeconds=0',
  'CancelTransitionsOut=false',
  'TimerSeconds=-1',
  'TimerMetricsGroup=',
];

const OVERLAY_LINE = /^(\s*OverlayScreens\s*=\s*)("?)([^"\r\n]*)("?)(\s*)$/;
const SECTION = /^\s*\[([^\]]*)\]/;

/** The indexes of the OverlayScreens lines in [Common] sections. */
function overlayLines(lines: string[]): number[] {
  let common = false;
  const found: number[] = [];
  lines.forEach((line, i) => {
    const section = SECTION.exec(line);
    if (section) common = section[1].trim().toLowerCase() === 'common';
    else if (common && OVERLAY_LINE.test(line)) found.push(i);
  });
  return found;
}

const listOf = (line: string) => (OVERLAY_LINE.exec(line)?.[3] ?? '').split(',').map((n) => n.trim()).filter(Boolean);
const isOurSection = (line: string) => SECTION.exec(line)?.[1].trim().toLowerCase() === OVERLAY_SCREEN.toLowerCase();

/** In a metrics.ini: how many OverlayScreens lists it has, how many of them have the helper, and whether it defines the helper's screen. */
export function overlayState(text: string): { lists: number; withUs: number; section: boolean } {
  const lines = text.split(/\r?\n/);
  const at = overlayLines(lines);
  return { lists: at.length, withUs: at.filter((i) => listOf(lines[i]).includes(OVERLAY_SCREEN)).length, section: lines.some(isOurSection) };
}

/** A metrics.ini with the helper first in each OverlayScreens list, and (for _fallback) its screen's section at the end. */
export function withOverlay(text: string, section: boolean): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  for (const i of overlayLines(lines)) {
    const names = listOf(lines[i]);
    if (names.includes(OVERLAY_SCREEN)) continue;
    lines[i] = lines[i].replace(OVERLAY_LINE, (_, head: string, open: string, _list: string, close: string, tail: string) => `${head}${open}${[OVERLAY_SCREEN, ...names].join(',')}${close}${tail}`);
  }
  let out = lines.join(eol);
  if (section && !lines.some(isOurSection)) out += (out.endsWith(eol) || out === '' ? '' : eol) + eol + OVERLAY_SECTION.join(eol) + eol;
  return out;
}

/** A metrics.ini without the helper: its name out of each OverlayScreens list and its section gone (the rest as it was). */
export function withoutOverlay(text: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let lines = text.split(/\r?\n/);
  for (const i of overlayLines(lines)) {
    const names = listOf(lines[i]);
    if (!names.includes(OVERLAY_SCREEN)) continue;
    lines[i] = lines[i].replace(OVERLAY_LINE, (_, head: string, open: string, _list: string, close: string, tail: string) => `${head}${open}${names.filter((n) => n !== OVERLAY_SCREEN).join(',')}${close}${tail}`);
  }
  const start = lines.findIndex(isOurSection);
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !SECTION.test(lines[end])) end++;
    // The section's own last line break stays as the file's; the blank line before it goes.
    if (end === lines.length && lines[end - 1] === '') end--;
    const from = start > 0 && lines[start - 1].trim() === '' ? start - 1 : start;
    lines = [...lines.slice(0, from), ...lines.slice(end)];
  }
  return lines.join(eol);
}
