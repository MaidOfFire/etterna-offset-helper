// Copied from Better Arrow Vortex (src/model/simfileIO.ts).
// Reading and writing .sm and .ssc simfiles.

import { findStyle } from './styles';
import {
  DIFFICULTIES,
  META_TAGS,
  ROWS_PER_MEASURE,
  cloneTiming,
  emptyMeta,
  emptyTiming,
  type Chart,
  type Difficulty,
  type MetaTag,
  type Note,
  type EditorMeta,
  type Simfile,
  type TimingData,
} from './types';

// ------------------------------------------------------------------------------------------------
// Editor metadata stored as a comment. StepMania, Etterna and ArrowVortex all skip `//` comments
// between tags (Etterna only outside tag values, so the line must sit between tags).

const META_PREFIX = '//@better-arrow-vortex ';

export function readEditorMeta(text: string): EditorMeta | undefined {
  const m = /^[ \t]*\/\/@better-arrow-vortex[ \t]+(\{.*\})[ \t]*\r?$/m.exec(text);
  if (!m) return undefined;
  try {
    const data = JSON.parse(m[1]) as EditorMeta & { v?: number };
    const sections = Array.isArray(data.sections)
      ? data.sections.filter((s) => s && typeof s.length === 'number' && s.length > 0 && Array.isArray(s.starts) && s.starts.every((x) => typeof x === 'number'))
      : undefined;
    return sections ? { sections } : {};
  } catch {
    return undefined;
  }
}

function editorMetaLines(sim: Simfile): string[] {
  const sections = sim.editor?.sections;
  if (!sections?.length) return [];
  const round = (x: number) => Math.round(x * 1000) / 1000;
  const data = {
    v: 1,
    sections: sections.map((s) => ({
      length: round(s.length),
      starts: s.starts.map(round),
      ...(s.auto ? { auto: true } : {}),
      ...(s.score !== undefined ? { score: Math.round(s.score * 100) / 100 } : {}),
    })),
  };
  return ['', '// Better Arrow Vortex: similar sections (a comment, ignored by StepMania / Etterna)', META_PREFIX + JSON.stringify(data)];
}

// ------------------------------------------------------------------------------------------------
// MSD tokenizer (#KEY:param:param;)

export interface MsdTag {
  key: string;
  params: string[];
}

/**
 * Splits MSD text into tags the way StepMania does: `//` comments are dropped, `:` separates
 * parameters, `;` ends a tag, and a `#` at the start of a line also ends an unterminated tag.
 */
export function parseMsd(text: string, unescape: boolean): MsdTag[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const out: MsdTag[] = [];
  let params: string[] | null = null;
  let buf = '';
  let lineHasContent = false;

  const finish = () => {
    if (!params) return;
    params.push(buf);
    out.push({ key: params[0].trim().toUpperCase(), params: params.slice(1) });
    params = null;
    buf = '';
  };

  for (let i = 0; i < text.length; ++i) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') ++i;
      --i;
      continue;
    }
    if (ch === '\n') lineHasContent = false;
    if (!params) {
      if (ch === '#') {
        params = [];
        buf = '';
      }
      if (ch !== '\n' && ch !== '\r' && ch !== ' ' && ch !== '\t') lineHasContent = true;
      continue;
    }
    if (unescape && ch === '\\' && i + 1 < text.length) {
      buf += text[++i];
      lineHasContent = true;
      continue;
    }
    if (ch === '#' && !lineHasContent) {
      // Missing semicolon: the previous tag ends here.
      buf = buf.replace(/\s+$/, '');
      finish();
      params = [];
      buf = '';
      lineHasContent = true;
      continue;
    }
    if (ch === ':') {
      params.push(buf);
      buf = '';
    } else if (ch === ';') {
      finish();
    } else {
      buf += ch;
    }
    if (ch !== '\n' && ch !== '\r' && ch !== ' ' && ch !== '\t') lineHasContent = true;
  }
  finish();
  return out;
}

// ------------------------------------------------------------------------------------------------
// Value parsing helpers.

function num(s: string, fallback = 0): number {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : fallback;
}

/** Parses "a=b,c=d" lists into arrays of fields. */
function pairs(value: string): string[][] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length)
    .map((s) => s.split('=').map((x) => x.trim()));
}

const DIFFICULTY_ALIASES: Record<string, Difficulty> = {
  beginner: 'Beginner',
  easy: 'Easy',
  basic: 'Easy',
  light: 'Easy',
  medium: 'Medium',
  another: 'Medium',
  trick: 'Medium',
  standard: 'Medium',
  difficult: 'Medium',
  hard: 'Hard',
  ssr: 'Hard',
  maniac: 'Hard',
  heavy: 'Hard',
  challenge: 'Challenge',
  smaniac: 'Challenge',
  expert: 'Challenge',
  oni: 'Challenge',
  edit: 'Edit',
};

export function parseDifficulty(s: string): Difficulty {
  return DIFFICULTY_ALIASES[s.trim().toLowerCase()] ?? 'Edit';
}

/** Applies a timing tag to `t`. Returns false if the tag is not a timing tag. */
function applyTimingTag(t: TimingData, key: string, value: string): boolean {
  switch (key) {
    case 'OFFSET':
      t.offset = num(value);
      return true;
    case 'BPMS':
      t.bpms = pairs(value).map(([b, v]) => ({ beat: num(b), bpm: num(v) }));
      return true;
    case 'STOPS':
    case 'FREEZES':
      t.stops = pairs(value).map(([b, v]) => ({ beat: num(b), seconds: num(v) }));
      return true;
    case 'DELAYS':
      t.delays = pairs(value).map(([b, v]) => ({ beat: num(b), seconds: num(v) }));
      return true;
    case 'WARPS':
      t.warps = pairs(value).map(([b, v]) => ({ beat: num(b), length: num(v) }));
      return true;
    case 'TIMESIGNATURES':
      t.timeSigs = pairs(value).map(([b, n, d]) => ({ beat: num(b), num: num(n, 4), den: num(d, 4) }));
      return true;
    case 'LABELS':
      t.labels = pairs(value).map(([b, ...rest]) => ({ beat: num(b), text: rest.join('=') }));
      return true;
    case 'SPEEDS':
    case 'SCROLLS':
    case 'TICKCOUNTS':
    case 'COMBOS':
    case 'FAKES':
      t.extra = t.extra.filter((x) => x.key !== key);
      t.extra.push({ key, value: value.trim() });
      return true;
  }
  return false;
}

/**
 * Converts old-style negative BPMs and negative stops into warps, like StepMania 5 does when
 * loading an .sm file.
 */
export function normalizeTiming(t: TimingData): void {
  t.bpms.sort((a, b) => a.beat - b.beat);
  const bpms: typeof t.bpms = [];
  for (let i = 0; i < t.bpms.length; ++i) {
    const cur = t.bpms[i];
    if (cur.bpm >= 0) {
      bpms.push(cur);
      continue;
    }
    // Negative BPM from cur.beat until the next positive BPM.
    let j = i + 1;
    while (j < t.bpms.length && t.bpms[j].bpm < 0) ++j;
    if (j >= t.bpms.length) {
      bpms.push({ beat: cur.beat, bpm: -cur.bpm });
      continue;
    }
    const next = t.bpms[j];
    const rewind = ((next.beat - cur.beat) * 60) / -cur.bpm; // seconds rewound
    const catchUp = (rewind * next.bpm) / 60; // beats needed to win the time back
    t.warps.push({ beat: cur.beat, length: next.beat - cur.beat + catchUp });
    bpms.push({ beat: cur.beat, bpm: next.bpm });
    i = j - 1;
  }
  t.bpms = dedupeBeats(bpms);
  const stops: typeof t.stops = [];
  for (const s of t.stops) {
    if (s.seconds >= 0) {
      stops.push(s);
    } else {
      const bpm = [...t.bpms].reverse().find((b) => b.beat <= s.beat)?.bpm ?? t.bpms[0]?.bpm ?? 120;
      t.warps.push({ beat: s.beat, length: (-s.seconds * bpm) / 60 });
    }
  }
  t.stops = stops;
  t.warps.sort((a, b) => a.beat - b.beat);
  t.stops.sort((a, b) => a.beat - b.beat);
  t.delays.sort((a, b) => a.beat - b.beat);
  t.timeSigs.sort((a, b) => a.beat - b.beat);
  t.labels.sort((a, b) => a.beat - b.beat);
  if (!t.bpms.length) t.bpms.push({ beat: 0, bpm: 120 });
}

function dedupeBeats<T extends { beat: number }>(list: T[]): T[] {
  const out: T[] = [];
  for (const x of list) {
    if (out.length && Math.abs(out[out.length - 1].beat - x.beat) < 1e-9) out[out.length - 1] = x;
    else out.push(x);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Note data.

export function parseNoteData(data: string, numCols: number): Note[] {
  const notes: Note[] = [];
  const pending: (Note | null)[] = new Array(numCols).fill(null);
  // Routine charts separate players with '&'; only the first player is edited.
  const playerData = data.split('&')[0];
  const measures = playerData.split(',');
  for (let m = 0; m < measures.length; ++m) {
    const lines = measures[m]
      .split('\n')
      .map((l) => l.replace(/\[[^\]]*\]|\{[^}]*\}/g, '').trim())
      .filter((l) => l.length > 0);
    const n = lines.length;
    for (let j = 0; j < n; ++j) {
      const row = m * ROWS_PER_MEASURE + Math.round((j * ROWS_PER_MEASURE) / n);
      const line = lines[j];
      for (let c = 0; c < numCols && c < line.length; ++c) {
        const ch = line[c].toUpperCase();
        switch (ch) {
          case '1':
            notes.push({ row, col: c, type: 'tap', endRow: row });
            break;
          case '2':
          case '4': {
            const head: Note = { row, col: c, type: ch === '2' ? 'hold' : 'roll', endRow: row };
            pending[c] = head;
            break;
          }
          case '3': {
            const head = pending[c];
            if (head) {
              notes.push({ ...head, endRow: row });
              pending[c] = null;
            }
            break;
          }
          case 'M':
            notes.push({ row, col: c, type: 'mine', endRow: row });
            break;
          case 'L':
            notes.push({ row, col: c, type: 'lift', endRow: row });
            break;
          case 'F':
            notes.push({ row, col: c, type: 'fake', endRow: row });
            break;
        }
      }
    }
  }
  // Holds without a tail become taps.
  for (const head of pending) if (head) notes.push({ ...head, type: 'tap' });
  notes.sort((a, b) => a.row - b.row || a.col - b.col);
  return notes;
}

const MEASURE_SUBDIVS = [4, 8, 12, 16, 24, 32, 48, 64, 96, 192];

function noteChar(n: Note): string {
  switch (n.type) {
    case 'tap':
      return '1';
    case 'hold':
      return n.endRow > n.row ? '2' : '1';
    case 'roll':
      return n.endRow > n.row ? '4' : '1';
    case 'mine':
      return 'M';
    case 'lift':
      return 'L';
    case 'fake':
      return 'F';
  }
}

export function writeNoteData(notes: readonly Note[], numCols: number): string {
  // Collect characters per row.
  const rows = new Map<number, string[]>();
  const put = (row: number, col: number, ch: string) => {
    let line = rows.get(row);
    if (!line) rows.set(row, (line = new Array(numCols).fill('0')));
    if (col < numCols) line[col] = ch;
  };
  let lastRow = 0;
  for (const n of notes) {
    put(n.row, n.col, noteChar(n));
    if (n.endRow > n.row && (n.type === 'hold' || n.type === 'roll')) put(n.endRow, n.col, '3');
    lastRow = Math.max(lastRow, n.endRow);
  }
  const numMeasures = Math.floor(lastRow / ROWS_PER_MEASURE) + 1;
  const empty = '0'.repeat(numCols);
  const out: string[] = [];
  for (let m = 0; m < numMeasures; ++m) {
    const base = m * ROWS_PER_MEASURE;
    const used: number[] = [];
    for (let r = 0; r < ROWS_PER_MEASURE; ++r) if (rows.has(base + r)) used.push(r);
    const subdiv = MEASURE_SUBDIVS.find((s) => used.every((r) => r % (ROWS_PER_MEASURE / s) === 0)) ?? 192;
    const step = ROWS_PER_MEASURE / subdiv;
    const lines: string[] = [];
    for (let r = 0; r < ROWS_PER_MEASURE; r += step) {
      const line = rows.get(base + r);
      lines.push(line ? line.join('') : empty);
    }
    out.push(lines.join('\n'));
  }
  return out.join('\n,\n');
}

// ------------------------------------------------------------------------------------------------
// Loading.

export function loadSm(text: string): Simfile {
  const sim: Simfile = { meta: emptyMeta(), timing: emptyTiming(), charts: [], extraTags: [] };
  sim.timing.bpms = [];
  for (const tag of parseMsd(text, true)) {
    const value = tag.params.join(':');
    if ((META_TAGS as readonly string[]).includes(tag.key)) {
      sim.meta[tag.key as MetaTag] = value.trim();
    } else if (applyTimingTag(sim.timing, tag.key, value)) {
      // handled
    } else if (tag.key === 'NOTES' || tag.key === 'NOTES2') {
      const p = tag.params.map((s) => s.trim());
      if (p.length < 6) continue;
      const stepsType = p[0];
      const style = findStyle(stepsType);
      sim.charts.push({
        stepsType,
        description: p[1],
        difficulty: parseDifficulty(p[2]),
        meter: Math.round(num(p[3], 1)),
        radarValues: p[4],
        credit: '',
        chartName: '',
        notes: parseNoteData(p[5], style.columns.length),
        timing: null,
        extraTags: [],
      });
    } else {
      sim.extraTags.push({ key: tag.key, value });
    }
  }
  normalizeTiming(sim.timing);
  sim.editor = readEditorMeta(text);
  return sim;
}

const SSC_CHART_TIMING = ['OFFSET', 'BPMS', 'STOPS', 'DELAYS', 'WARPS', 'TIMESIGNATURES', 'LABELS', 'SPEEDS', 'SCROLLS', 'TICKCOUNTS', 'COMBOS', 'FAKES'];

export function loadSsc(text: string): Simfile {
  const sim: Simfile = { meta: emptyMeta(), timing: emptyTiming(), charts: [], extraTags: [] };
  sim.timing.bpms = [];
  let chart: Chart | null = null;
  let chartTiming: TimingData | null = null;

  const endChart = () => {
    if (chart) {
      if (chartTiming) {
        normalizeTiming(chartTiming);
        chart.timing = chartTiming;
      }
      sim.charts.push(chart);
    }
    chart = null;
    chartTiming = null;
  };

  for (const tag of parseMsd(text, true)) {
    const value = tag.params.join(':');
    if (tag.key === 'NOTEDATA') {
      endChart();
      chart = {
        stepsType: 'dance-single',
        description: '',
        difficulty: 'Edit',
        meter: 1,
        radarValues: '',
        credit: '',
        chartName: '',
        notes: [],
        timing: null,
        extraTags: [],
      };
      continue;
    }
    if (!chart) {
      if (tag.key === 'VERSION') continue;
      if ((META_TAGS as readonly string[]).includes(tag.key)) sim.meta[tag.key as MetaTag] = value.trim();
      else if (!applyTimingTag(sim.timing, tag.key, value)) sim.extraTags.push({ key: tag.key, value });
      continue;
    }
    const c: Chart = chart;
    switch (tag.key) {
      case 'STEPSTYPE':
        c.stepsType = value.trim();
        break;
      case 'DESCRIPTION':
        c.description = value.trim();
        break;
      case 'DIFFICULTY':
        c.difficulty = parseDifficulty(value);
        break;
      case 'METER':
        c.meter = Math.round(num(value, 1));
        break;
      case 'RADARVALUES':
        c.radarValues = value.trim();
        break;
      case 'CREDIT':
        c.credit = value.trim();
        break;
      case 'CHARTNAME':
        c.chartName = value.trim();
        break;
      case 'NOTES':
      case 'NOTES2':
        c.notes = parseNoteData(value, findStyle(c.stepsType).columns.length);
        break;
      default:
        if (SSC_CHART_TIMING.includes(tag.key)) {
          if (!chartTiming) {
            normalizeTiming(sim.timing);
            chartTiming = cloneTiming(sim.timing);
          }
          applyTimingTag(chartTiming, tag.key, value);
        } else {
          c.extraTags.push({ key: tag.key, value });
        }
    }
  }
  endChart();
  normalizeTiming(sim.timing);
  sim.editor = readEditorMeta(text);
  return sim;
}

export function loadSimfile(text: string, fileName: string): Simfile {
  return fileName.toLowerCase().endsWith('.ssc') ? loadSsc(text) : loadSm(text);
}

// ------------------------------------------------------------------------------------------------
// Saving.

const f6 = (v: number) => v.toFixed(6);

function escapeValue(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/;/g, '\\;').replace(/#/g, '\\#');
}

function list(items: string[]): string {
  return items.length > 1 ? items.join('\n,') : items.join(',');
}

/** Encodes a warp as a negative/positive BPM pair (the .sm way). Returns false if impossible. */
function warpsToNegativeBpms(t: TimingData): { bpms: TimingData['bpms']; lost: number } {
  const bpms = t.bpms.map((b) => ({ ...b }));
  let lost = 0;
  for (const w of t.warps) {
    const end = w.beat + w.length;
    const at = [...bpms].reverse().find((b) => b.beat <= w.beat + 1e-9);
    const bpm = at ? at.bpm : bpms[0].bpm;
    const isInside = (b: { beat: number }) => b.beat > w.beat + 1e-9 && b.beat < end - 1e-9;
    // BPM changes inside the warp that keep the same tempo are redundant and can be dropped.
    if (bpms.some((b) => isInside(b) && b.bpm !== bpm) || w.length <= 0) {
      ++lost;
      continue;
    }
    const rest = bpms.filter((b) => Math.abs(b.beat - w.beat) > 1e-9 && !isInside(b));
    rest.push({ beat: w.beat, bpm: -bpm }, { beat: w.beat + w.length / 2, bpm });
    bpms.length = 0;
    bpms.push(...rest.sort((a, b) => a.beat - b.beat));
  }
  return { bpms, lost };
}

function timingLines(t: TimingData, ssc: boolean, warnings: string[]): string[] {
  const out: string[] = [];
  out.push(`#OFFSET:${f6(t.offset)};`);
  let bpms = t.bpms;
  if (!ssc && t.warps.length) {
    const enc = warpsToNegativeBpms(t);
    bpms = enc.bpms;
    if (enc.lost) warnings.push(`${enc.lost} warp(s) could not be stored in .sm; save as .ssc to keep them.`);
  }
  out.push(`#BPMS:${list(bpms.map((b) => `${f6(b.beat)}=${f6(b.bpm)}`))};`);
  out.push(`#STOPS:${list(t.stops.map((s) => `${f6(s.beat)}=${f6(s.seconds)}`))};`);
  if (t.delays.length) out.push(`#DELAYS:${list(t.delays.map((s) => `${f6(s.beat)}=${f6(s.seconds)}`))};`);
  if (ssc && t.warps.length) out.push(`#WARPS:${list(t.warps.map((w) => `${f6(w.beat)}=${f6(w.length)}`))};`);
  if (t.timeSigs.length) out.push(`#TIMESIGNATURES:${list(t.timeSigs.map((s) => `${f6(s.beat)}=${s.num}=${s.den}`))};`);
  if (ssc) {
    if (t.labels.length) out.push(`#LABELS:${list(t.labels.map((l) => `${f6(l.beat)}=${l.text}`))};`);
    for (const x of t.extra) out.push(`#${x.key}:${x.value};`);
  } else if (t.labels.length || t.extra.length) {
    warnings.push('Labels and SM5 segments (speeds, scrolls, ...) are only kept in .ssc files.');
  }
  return out;
}

function metaLines(sim: Simfile): string[] {
  return META_TAGS.map((k) => `#${k}:${escapeValue(sim.meta[k])};`);
}

export interface SaveResult {
  text: string;
  warnings: string[];
}

export function saveSm(sim: Simfile): SaveResult {
  const warnings: string[] = [];
  const out: string[] = [];
  const meta = metaLines(sim);
  // SAMPLESTART, SAMPLELENGTH, SELECTABLE and DISPLAYBPM come after OFFSET in StepMania's writer.
  const head = meta.slice(0, META_TAGS.indexOf('SAMPLESTART'));
  const tail = meta.slice(META_TAGS.indexOf('SAMPLESTART')).filter((l) => !/^#DISPLAYBPM:;$/.test(l));
  out.push(...head);
  const timing = timingLines(sim.timing, false, warnings);
  out.push(timing[0], ...tail, ...timing.slice(1));
  for (const x of sim.extraTags) out.push(`#${x.key}:${x.value};`);
  out.push(...editorMetaLines(sim));
  if (sim.charts.some((c) => c.timing)) warnings.push('Per-chart timing is only kept in .ssc files.');
  for (const c of sim.charts) {
    const cols = findStyle(c.stepsType).columns.length;
    out.push('');
    out.push(`//---------------${c.stepsType} - ${c.description}----------------`);
    out.push('#NOTES:');
    out.push(`     ${c.stepsType}:`);
    out.push(`     ${escapeValue(c.description)}:`);
    out.push(`     ${c.difficulty}:`);
    out.push(`     ${c.meter}:`);
    out.push(`     ${c.radarValues || '0.000000,0.000000,0.000000,0.000000,0.000000'}:`);
    out.push(writeNoteData(c.notes, cols));
    out.push(';');
  }
  return { text: out.join('\n') + '\n', warnings };
}

export function saveSsc(sim: Simfile): SaveResult {
  const warnings: string[] = [];
  const out: string[] = ['#VERSION:0.83;'];
  out.push(...metaLines(sim));
  out.push(...timingLines(sim.timing, true, warnings));
  for (const x of sim.extraTags) out.push(`#${x.key}:${x.value};`);
  out.push(...editorMetaLines(sim));
  for (const c of sim.charts) {
    const cols = findStyle(c.stepsType).columns.length;
    out.push('');
    out.push(`//---------------${c.stepsType} - ${c.description}----------------`);
    out.push('#NOTEDATA:;');
    out.push(`#CHARTNAME:${escapeValue(c.chartName)};`);
    out.push(`#STEPSTYPE:${c.stepsType};`);
    out.push(`#DESCRIPTION:${escapeValue(c.description)};`);
    out.push(`#DIFFICULTY:${c.difficulty};`);
    out.push(`#METER:${c.meter};`);
    out.push(`#RADARVALUES:${c.radarValues};`);
    out.push(`#CREDIT:${escapeValue(c.credit)};`);
    for (const x of c.extraTags) out.push(`#${x.key}:${x.value};`);
    if (c.timing) out.push(...timingLines(c.timing, true, warnings));
    out.push('#NOTES:');
    out.push(writeNoteData(c.notes, cols));
    out.push(';');
  }
  return { text: out.join('\n') + '\n', warnings };
}

export function saveSimfile(sim: Simfile, fileName: string): SaveResult {
  return fileName.toLowerCase().endsWith('.ssc') ? saveSsc(sim) : saveSm(sim);
}

export function isDifficulty(s: string): s is Difficulty {
  return (DIFFICULTIES as readonly string[]).includes(s);
}
