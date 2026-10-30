// Copied from Better Arrow Vortex (src/model/styles.ts).
// Game styles (#NOTES steps types) and how their columns are drawn.

/** How a column's notes are drawn: an arrow rotated by `angle` degrees (0 = up), or a shape. */
export type ColumnShape = { kind: 'arrow'; angle: number } | { kind: 'center' } | { kind: 'bar' };

export interface GameStyle {
  id: string;
  name: string;
  columns: ColumnShape[];
}

const L: ColumnShape = { kind: 'arrow', angle: -90 };
const D: ColumnShape = { kind: 'arrow', angle: 180 };
const U: ColumnShape = { kind: 'arrow', angle: 0 };
const R: ColumnShape = { kind: 'arrow', angle: 90 };
const UL: ColumnShape = { kind: 'arrow', angle: -45 };
const UR: ColumnShape = { kind: 'arrow', angle: 45 };
const DL: ColumnShape = { kind: 'arrow', angle: -135 };
const DR: ColumnShape = { kind: 'arrow', angle: 135 };
const C: ColumnShape = { kind: 'center' };
const B: ColumnShape = { kind: 'bar' };

const bars = (n: number): ColumnShape[] => Array.from({ length: n }, () => B);

export const GAME_STYLES: GameStyle[] = [
  { id: 'dance-single', name: 'Dance Single', columns: [L, D, U, R] },
  { id: 'dance-double', name: 'Dance Double', columns: [L, D, U, R, L, D, U, R] },
  { id: 'dance-couple', name: 'Dance Couple', columns: [L, D, U, R, L, D, U, R] },
  { id: 'dance-solo', name: 'Dance Solo', columns: [L, UL, D, U, UR, R] },
  { id: 'dance-threepanel', name: 'Dance Three-panel', columns: [UL, D, UR] },
  { id: 'dance-routine', name: 'Dance Routine', columns: [L, D, U, R, L, D, U, R] },
  { id: 'pump-single', name: 'Pump Single', columns: [DL, UL, C, UR, DR] },
  { id: 'pump-halfdouble', name: 'Pump Half-double', columns: [C, UR, DR, DL, UL, C] },
  { id: 'pump-double', name: 'Pump Double', columns: [DL, UL, C, UR, DR, DL, UL, C, UR, DR] },
  { id: 'pump-couple', name: 'Pump Couple', columns: [DL, UL, C, UR, DR, DL, UL, C, UR, DR] },
  { id: 'kb7-single', name: 'KB7 Single', columns: bars(7) },
  { id: 'pnm-five', name: "Pop'n Five", columns: bars(5) },
  { id: 'pnm-nine', name: "Pop'n Nine", columns: bars(9) },
  { id: 'techno-single4', name: 'Techno Single 4', columns: [L, D, U, R] },
  { id: 'techno-single5', name: 'Techno Single 5', columns: [DL, UL, C, UR, DR] },
  { id: 'techno-single8', name: 'Techno Single 8', columns: [DL, L, UL, D, U, UR, R, DR] },
  { id: 'beat-single5', name: 'Beat Single 5', columns: bars(6) },
  { id: 'beat-single7', name: 'Beat Single 7', columns: bars(8) },
];

export function findStyle(stepsType: string): GameStyle {
  const id = stepsType.trim().toLowerCase();
  const style = GAME_STYLES.find((s) => s.id === id);
  if (style) return style;
  // Unknown steps type: guess a bar layout from a trailing number, default to 4 columns.
  const m = /(\d+)$/.exec(id);
  const n = m ? Math.min(16, Math.max(1, parseInt(m[1], 10))) : 4;
  return { id, name: stepsType, columns: bars(n) };
}
