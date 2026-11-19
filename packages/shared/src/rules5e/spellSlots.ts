/** Tabelle numeriche degli slot incantesimo, livelli 1-20. Indice array = livello di slot - 1. */
import { MAX_LEVEL, MIN_LEVEL } from "./abilities.js";

export type CasterKind = "full" | "half" | "third" | "pact";
export type SlotRow = readonly number[]; // lunghezza 9

const r = (...n: number[]): SlotRow => [...n, ...Array<number>(9 - n.length).fill(0)];

/** Incantatori completi. */
export const FULL_CASTER_SLOTS: readonly SlotRow[] = [
  r(2), r(3), r(4, 2), r(4, 3), r(4, 3, 2), r(4, 3, 3), r(4, 3, 3, 1), r(4, 3, 3, 2),
  r(4, 3, 3, 3, 1), r(4, 3, 3, 3, 2), r(4, 3, 3, 3, 2, 1), r(4, 3, 3, 3, 2, 1),
  r(4, 3, 3, 3, 2, 1, 1), r(4, 3, 3, 3, 2, 1, 1), r(4, 3, 3, 3, 2, 1, 1, 1),
  r(4, 3, 3, 3, 2, 1, 1, 1), r(4, 3, 3, 3, 2, 1, 1, 1, 1), r(4, 3, 3, 3, 3, 1, 1, 1, 1),
  r(4, 3, 3, 3, 3, 2, 1, 1, 1), r(4, 3, 3, 3, 3, 2, 2, 1, 1),
];

/** Mezzi incantatori (livello 1: nessuno slot). */
export const HALF_CASTER_SLOTS: readonly SlotRow[] = [
  r(), r(2), r(3), r(3), r(4, 2), r(4, 2), r(4, 3), r(4, 3), r(4, 3, 2), r(4, 3, 2),
  r(4, 3, 3), r(4, 3, 3), r(4, 3, 3, 1), r(4, 3, 3, 1), r(4, 3, 3, 2), r(4, 3, 3, 2),
  r(4, 3, 3, 3, 1), r(4, 3, 3, 3, 1), r(4, 3, 3, 3, 2), r(4, 3, 3, 3, 2),
];

/** Terzi di incantatore (sottoclassi). */
export const THIRD_CASTER_SLOTS: readonly SlotRow[] = [
  r(), r(), r(2), r(3), r(3), r(3), r(4, 2), r(4, 2), r(4, 2), r(4, 3), r(4, 3), r(4, 3),
  r(4, 3, 2), r(4, 3, 2), r(4, 3, 2), r(4, 3, 3), r(4, 3, 3), r(4, 3, 3), r(4, 3, 3, 1),
  r(4, 3, 3, 1),
];

export interface PactSlots {
  count: number;
  slotLevel: number;
}

/** Magia del patto: numero di slot e livello (tutti dello stesso livello). */
export const PACT_SLOTS: readonly PactSlots[] = [
  [1, 1], [2, 1], [2, 2], [2, 2], [2, 3], [2, 3], [2, 4], [2, 4], [2, 5], [2, 5],
  [3, 5], [3, 5], [3, 5], [3, 5], [3, 5], [3, 5], [4, 5], [4, 5], [4, 5], [4, 5],
].map(([count, slotLevel]) => ({ count: count!, slotLevel: slotLevel! }));

function index(level: number): number {
  if (!Number.isInteger(level) || level < MIN_LEVEL || level > MAX_LEVEL) {
    throw new RangeError(`Livello fuori intervallo: ${level}`);
  }
  return level - 1;
}

/** Slot per livello di slot per incantatori completi, mezzi o terzi. */
export function spellSlotsFor(kind: Exclude<CasterKind, "pact">, level: number): number[] {
  const table =
    kind === "full" ? FULL_CASTER_SLOTS : kind === "half" ? HALF_CASTER_SLOTS : THIRD_CASTER_SLOTS;
  return [...table[index(level)]!];
}

export function pactSlotsFor(level: number): PactSlots {
  return { ...PACT_SLOTS[index(level)]! };
}

/**
 * Livello di incantatore multiclasse: completi per intero, mezzi per eccesso,
 * terzi per difetto. La magia del patto e esclusa (slot separati).
 */
export function multiclassCasterLevel(
  classes: readonly { kind: CasterKind; level: number }[],
): number {
  let total = 0;
  for (const c of classes) {
    if (c.kind === "full") total += c.level;
    else if (c.kind === "half") total += Math.ceil(c.level / 2);
    else if (c.kind === "third") total += Math.floor(c.level / 3);
  }
  return Math.min(total, MAX_LEVEL);
}

/** Slot condivisi di una combinazione di classi (una sola classe: tabella propria). */
export function combinedSpellSlots(
  classes: readonly { kind: CasterKind; level: number }[],
): number[] {
  const sharing = classes.filter((c) => c.kind !== "pact");
  const only = sharing.length === 1 ? sharing[0]! : undefined;
  if (only && only.kind !== "pact") return spellSlotsFor(only.kind, only.level);
  const lvl = multiclassCasterLevel(sharing);
  return lvl === 0 ? Array<number>(9).fill(0) : spellSlotsFor("full", lvl);
}
