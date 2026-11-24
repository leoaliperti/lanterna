import {
  CONDITIONS,
  LIMITS,
  engineSheet,
  rollFor,
  type Ability,
  type CharacterSheet,
  type Proficiency,
  type RollEntry,
  type RollSpec,
  type RollTarget,
  type RulesContent,
  type SheetDoc,
  type SheetSummary,
  type Skill,
  type TokenView
} from "@lanterna/shared";
import { CONDITION_LABELS } from "../table/conditions";

/** Logica pura della scheda nel client: etichette, ricerca, tiri, operazioni sul documento e sincronizzazione con il token. */

export const ABILITY_LABEL: Record<Ability, string> = {
  str: "Forza",
  dex: "Destrezza",
  con: "Costituzione",
  int: "Intelligenza",
  wis: "Saggezza",
  cha: "Carisma"
};

export const ABILITY_SHORT: Record<Ability, string> = { str: "FOR", dex: "DES", con: "COS", int: "INT", wis: "SAG", cha: "CAR" };

export const SKILL_LABEL: Record<Skill, string> = {
  acrobatics: "Acrobazia",
  animalHandling: "Addestrare animali",
  arcana: "Arcano",
  athletics: "Atletica",
  deception: "Inganno",
  history: "Storia",
  insight: "Intuizione",
  intimidation: "Intimidire",
  investigation: "Indagare",
  medicine: "Medicina",
  nature: "Natura",
  perception: "Percezione",
  performance: "Intrattenere",
  persuasion: "Persuasione",
  religion: "Religione",
  sleightOfHand: "Rapidità di mano",
  stealth: "Furtività",
  survival: "Sopravvivenza"
};

export const PROFICIENCY_LABEL: Record<Proficiency, string> = {
  none: "Nessuna",
  half: "Competenza",
  proficient: "Competenza",
  expertise: "Competenza"
};

/** Abilità: solo sì o no (le regole non hanno gradi intermedi). */
export const SKILL_PROFICIENCY_OPTIONS: ReadonlyArray<{ value: Proficiency; label: string }> = [
  { value: "none", label: "Nessuna" },
  { value: "proficient", label: "Competenza" }
];

export const SIZE_LABEL = {
  tiny: "Minuscola",
  small: "Piccola",
  medium: "Media",
  large: "Grande",
  huge: "Enorme",
  gargantuan: "Mastodontica"
} as const;

export const CASTER_LABEL = { full: "Pieno", half: "Mezzo", third: "Un terzo", pact: "Patto" } as const;

export function signed(n: number): string {
  return n >= 0 ? `+${n}` : `−${Math.abs(n)}`;
}

/** Testo senza maiuscole né accenti, per cercare in modo tollerante. */
export function normalize(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("it").replace(/[']/g, "");
}

/** Vero se ogni parola della ricerca compare in almeno uno dei testi. */
export function matchesQuery(query: string, ...texts: Array<string | undefined>): boolean {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = normalize(texts.filter(Boolean).join(" "));
  return words.every((w) => hay.includes(w));
}

/** Formula da inviare al server: `1d20+5`, con ` adv`/` dis` dalle condizioni. `null` = fallimento automatico (nessun tiro). */
export function formulaOf(spec: RollSpec): string | null {
  if (spec.autoFail) return null;
  return spec.formula + (spec.advantage ? " adv" : spec.disadvantage ? " dis" : "");
}

export function rollTargetFor(doc: SheetDoc, target: RollTarget): RollSpec {
  const { sheet, content } = engineSheet(doc);
  return rollFor(sheet, content, target);
}

/** Descrizione breve del vantaggio/svantaggio per chi legge (e per gli screen reader). */
export function modeNote(spec: RollSpec): string | null {
  if (spec.autoFail) return "fallimento automatico";
  if (spec.advantage) return "vantaggio";
  if (spec.disadvantage) return "svantaggio";
  return null;
}

/** Valore naturale del d20 tenuto in un tiro (per i tiri contro la morte). */
export function naturalD20(entry: RollEntry): number | null {
  for (const t of entry.terms) {
    if (t.kind !== "dice" || t.sides !== 20) continue;
    const kept = t.dice.find((d) => d.kept) ?? t.dice[0];
    if (kept) return kept.value;
  }
  return null;
}

/** Valore naturale del primo dado di un tiro (dadi vita). */
export function firstDie(entry: RollEntry): number | null {
  for (const t of entry.terms) {
    if (t.kind === "dice" && t.dice[0]) return (t.dice.find((d) => d.kept) ?? t.dice[0]).value;
  }
  return null;
}

type SheetOp = (sheet: CharacterSheet, content: RulesContent) => CharacterSheet;

/**
 * Applica un'operazione del motore (danno, cura, riposo, slot...) al documento. L'operazione lavora sulla
 * scheda "per il motore" (peso e armatura risolti); si copiano indietro solo i campi che le operazioni modificano.
 */
export function applySheetOp(doc: SheetDoc, op: SheetOp): SheetDoc {
  const { sheet, content } = engineSheet(doc);
  const r = op(sheet, content);
  return {
    ...doc,
    sheet: {
      ...doc.sheet,
      hp: r.hp,
      classes: r.classes,
      slotsSpent: r.slotsSpent,
      pactSlotsSpent: r.pactSlotsSpent,
      conditions: r.conditions,
      exhaustion: r.exhaustion,
      heroicInspiration: r.heroicInspiration
    }
  };
}

/** Aggiorna un campo della scheda di regole. */
export function patchSheet(doc: SheetDoc, patch: Partial<CharacterSheet>): SheetDoc {
  return { ...doc, sheet: { ...doc.sheet, ...patch } };
}

export function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ---------------- Sincronizzazione scheda -> token (solo GM) ---------------- */

export interface TokenSyncUpdate {
  tokenId: string;
  patch: {
    health: { current: number; max: number; temp: number };
    conditions: Array<{ id: string; name: string }>;
  };
}

const ENGINE_CONDITIONS = new Set<string>(CONDITIONS);

function signatureOf(s: SheetSummary): string {
  return JSON.stringify([s.hp, s.conditions]);
}

/**
 * Regola: la scheda è la fonte di verità per PF e condizioni. Quando i PF o le condizioni di una scheda
 * collegata a un token CAMBIANO (rispetto all'ultima volta che il GM li ha visti), il client del GM li copia sul token.
 * La prima osservazione fissa solo il riferimento: non sovrascrive la barra del token. Se il token non ha ancora
 * una barra della vita, la riceve subito. Le condizioni del token che non sono del motore 5e restano.
 */
export function planTokenSync(
  previous: ReadonlyMap<string, string>,
  sheets: readonly SheetSummary[],
  tokens: readonly TokenView[]
): { updates: TokenSyncUpdate[]; next: Map<string, string> } {
  const next = new Map<string, string>();
  const updates: TokenSyncUpdate[] = [];
  for (const s of sheets) {
    const sig = signatureOf(s);
    next.set(s.id, sig);
    if (!s.tokenId) continue;
    const token = tokens.find((t) => t.id === s.tokenId);
    if (!token) continue;
    const seen = previous.get(s.id);
    const changed = seen !== undefined && seen !== sig;
    if (!changed && token.health) continue;
    const cap = LIMITS.hpMax;
    const max = Math.min(cap, s.hp.max);
    const health = { current: Math.min(max, s.hp.current), max, temp: Math.min(cap, s.hp.temp) };
    const keep = token.conditions.filter((c) => !ENGINE_CONDITIONS.has(c.id));
    const fromSheet = s.conditions.map((id) => ({ id, name: CONDITION_LABELS[id as keyof typeof CONDITION_LABELS] ?? id }));
    const conditions = [...keep, ...fromSheet].slice(0, LIMITS.maxConditions);
    updates.push({ tokenId: token.id, patch: { health, conditions } });
  }
  return { updates, next };
}
