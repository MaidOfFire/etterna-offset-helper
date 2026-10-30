// Copied from Better Arrow Vortex (src/model/types.ts).
// Core simfile data model shared by the parser, writer and editor.

export const ROWS_PER_BEAT = 48;
export const ROWS_PER_MEASURE = 192;

export type NoteType = 'tap' | 'hold' | 'roll' | 'mine' | 'lift' | 'fake';

/** A single note. Notes are treated as immutable; edits replace them. */
export interface Note {
  row: number;
  col: number;
  type: NoteType;
  /** Last row of a hold or roll; equal to `row` for every other type. */
  endRow: number;
}

export const DIFFICULTIES = ['Beginner', 'Easy', 'Medium', 'Hard', 'Challenge', 'Edit'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export interface Tag {
  key: string;
  value: string;
}

export interface BpmChange {
  beat: number;
  bpm: number;
}

/** Used for both stops and delays. */
export interface Pause {
  beat: number;
  seconds: number;
}

export interface Warp {
  beat: number;
  /** Length of the warp in beats. */
  length: number;
}

export interface TimeSig {
  beat: number;
  num: number;
  den: number;
}

export interface Label {
  beat: number;
  text: string;
}

export interface TimingData {
  /** #OFFSET in seconds; beat 0 plays at time -offset. */
  offset: number;
  bpms: BpmChange[];
  stops: Pause[];
  delays: Pause[];
  warps: Warp[];
  timeSigs: TimeSig[];
  labels: Label[];
  /** SM5 segment tags kept verbatim (SPEEDS, SCROLLS, TICKCOUNTS, COMBOS, FAKES). */
  extra: Tag[];
}

export interface Chart {
  stepsType: string;
  /** Description / step artist (the 2nd #NOTES field in .sm). */
  description: string;
  difficulty: Difficulty;
  meter: number;
  radarValues: string;
  /** .ssc only. */
  credit: string;
  /** .ssc only. */
  chartName: string;
  /** Sorted by row, then column. */
  notes: Note[];
  /** Split timing from an .ssc chart; null means the chart uses the song timing. */
  timing: TimingData | null;
  /** Unknown per-chart .ssc tags, written back unchanged. */
  extraTags: Tag[];
}

/** Header tags edited through Song Properties, in the order they are written. */
export const META_TAGS = [
  'TITLE',
  'SUBTITLE',
  'ARTIST',
  'TITLETRANSLIT',
  'SUBTITLETRANSLIT',
  'ARTISTTRANSLIT',
  'GENRE',
  'CREDIT',
  'BANNER',
  'BACKGROUND',
  'LYRICSPATH',
  'CDTITLE',
  'MUSIC',
  'SAMPLESTART',
  'SAMPLELENGTH',
  'SELECTABLE',
  'DISPLAYBPM',
] as const;
export type MetaTag = (typeof META_TAGS)[number];

/** A group of similar sections, stored in beats. */
export interface StoredSection {
  length: number;
  starts: number[];
  auto?: boolean;
  score?: number;
}

/** Editor-only data kept in the simfile as a comment line (games ignore it). */
export interface EditorMeta {
  sections?: StoredSection[];
}

export interface Simfile {
  meta: Record<MetaTag, string>;
  timing: TimingData;
  charts: Chart[];
  /** Other header tags (BGCHANGES, KEYSOUNDS, ATTACKS, ...) preserved in order. */
  extraTags: Tag[];
  editor?: EditorMeta;
}

export function emptyTiming(): TimingData {
  return {
    offset: 0,
    bpms: [{ beat: 0, bpm: 120 }],
    stops: [],
    delays: [],
    warps: [],
    timeSigs: [],
    labels: [],
    extra: [],
  };
}

export function cloneTiming(t: TimingData): TimingData {
  return {
    offset: t.offset,
    bpms: t.bpms.map((s) => ({ ...s })),
    stops: t.stops.map((s) => ({ ...s })),
    delays: t.delays.map((s) => ({ ...s })),
    warps: t.warps.map((s) => ({ ...s })),
    timeSigs: t.timeSigs.map((s) => ({ ...s })),
    labels: t.labels.map((s) => ({ ...s })),
    extra: t.extra.map((s) => ({ ...s })),
  };
}

export function emptyMeta(): Record<MetaTag, string> {
  const meta = {} as Record<MetaTag, string>;
  for (const tag of META_TAGS) meta[tag] = '';
  meta.SELECTABLE = 'YES';
  return meta;
}

export function newSimfile(): Simfile {
  return { meta: emptyMeta(), timing: emptyTiming(), charts: [], extraTags: [] };
}

export function newChart(stepsType: string, difficulty: Difficulty = 'Challenge', meter = 1): Chart {
  return {
    stepsType,
    description: '',
    difficulty,
    meter,
    radarValues: '',
    credit: '',
    chartName: '',
    notes: [],
    timing: null,
    extraTags: [],
  };
}

export function beatToRow(beat: number): number {
  return Math.round(beat * ROWS_PER_BEAT);
}

export function rowToBeat(row: number): number {
  return row / ROWS_PER_BEAT;
}
