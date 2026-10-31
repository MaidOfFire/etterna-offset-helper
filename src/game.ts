// Talking to the in-game part (theme/offsethelper.lua, installed into Til' Death). Etterna's Lua
// cannot read audio, so the page does the measuring: the theme writes OffsetHelper/request.txt
// in the Etterna folder ("measure this song", "apply choice 2", "undo") and the page answers in
// OffsetHelper/result.txt, with the sync map as a PNG next to it. Both are `key=value` lines.

/** The folder in the Etterna folder that both sides use. */
export const GAME_DIR = 'OffsetHelper';
/** The line added to Til' Death's song select decorations to load the in-game part. */
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

/** Til' Death's decorations with the in-game part loaded (before its `return t`), or null when it cannot be placed. */
export function withLoadLine(lua: string): string | null {
  if (lua.includes(LOAD_LINE)) return lua;
  const m = /\r?\n(\s*collectgarbage\(\)\s*\r?\n)?\s*return t\s*$/.exec(lua);
  if (!m) return null;
  const eol = lua.includes('\r\n') ? '\r\n' : '\n';
  return lua.slice(0, m.index) + eol + LOAD_LINE + lua.slice(m.index);
}

/** The decorations without the in-game part. */
export function withoutLoadLine(lua: string): string {
  return lua.replace(new RegExp(`\\r?\\n${LOAD_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), '');
}
