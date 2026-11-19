// Disposizione dei dadi sul tavolo: griglia centrata che sceglie il numero di colonne
// per avere i dadi piu' grandi possibile dentro l'area visibile.

/** Spazio occupato da un dado a scala 1 (diametro circa 1.6 piu' margine). */
export const CELL = 1.9;
export const MIN_SCALE = 0.3;

export interface TableLayout {
  /** Posizioni (x, z) dei centri, nell'ordine dei dadi. */
  readonly positions: readonly { readonly x: number; readonly z: number }[];
  /** Scala da applicare a ogni dado, tra MIN_SCALE e 1. */
  readonly scale: number;
}

export function layoutTable(count: number, tableWidth: number, tableDepth: number): TableLayout {
  if (count <= 0) return { positions: [], scale: 1 };
  let best = { cols: 1, k: -1 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const k = Math.min(tableWidth / cols, tableDepth / rows) / CELL;
    if (k > best.k) best = { cols, k };
  }
  const k = Math.min(1, Math.max(MIN_SCALE, best.k));
  const cell = CELL * k;
  const rows = Math.ceil(count / best.cols);
  const positions = Array.from({ length: count }, (_, i) => {
    const row = Math.floor(i / best.cols);
    const inRow = row === rows - 1 ? count - row * best.cols : best.cols; // ultima riga centrata
    const col = i - row * best.cols;
    return { x: (col - (inRow - 1) / 2) * cell, z: (row - (rows - 1) / 2) * cell };
  });
  return { positions, scale: k };
}
