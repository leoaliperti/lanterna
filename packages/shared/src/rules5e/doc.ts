/**
 * Documento di una scheda: `CharacterSheet` (regole) + dati extra che il motore non usa
 * (inventario, attacchi, incantesimi conosciuti, note, testo dello statblock).
 * Tutto serializzabile e validato con Zod: server (a ogni lettura e scrittura) e client usano lo stesso schema.
 * Nessun contenuto di gioco: i nomi e i testi li inserisce l'utente o arrivano dall'importazione.
 */
import { z } from "zod";
import { ABILITIES, type Ability } from "./abilities.js";
import type { ArmorDef } from "./armor.js";
import { hpStateOf } from "./ops.js";
import {
  characterSheetSchema,
  derive,
  type CharacterSheet,
  type DerivedSheet,
  type RulesContent,
} from "./sheet.js";

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const noteText = z.string().max(2000);

export const armorDefSchema = z.strictObject({
  category: z.enum(["light", "medium", "heavy"]),
  baseAc: z.number().int().min(0).max(30),
  strengthRequirement: z.number().int().min(1).max(30).optional(),
  stealthDisadvantage: z.boolean().optional(),
});

export const sheetItemSchema = z.strictObject({
  id,
  name: z.string().min(1).max(200),
  quantity: z.number().int().min(0).max(9999).default(1),
  /** Peso di una unità, in libbre. */
  weight: z.number().min(0).max(10000).default(0),
  equipped: z.boolean().default(false),
  notes: noteText.default(""),
  /** Documento importato da cui viene (facoltativo). */
  contentId: id.optional(),
  /** Se presente l'oggetto è un'armatura: il suo id si può mettere in `sheet.equipment.armorId`. */
  armor: armorDefSchema.optional(),
});
export type SheetItem = z.infer<typeof sheetItemSchema>;

export const sheetAttackSchema = z.strictObject({
  id,
  name: z.string().min(1).max(200),
  ability: z.enum(ABILITIES),
  proficient: z.boolean().default(true),
  bonus: z.number().int().min(-20).max(40).default(0),
  /** Formula di danno (es. `1d8+3`), tirata dal server come ogni formula. */
  damage: z.string().max(100).default(""),
  damageType: z.string().max(50).default(""),
  contentId: id.optional(),
});
export type SheetAttack = z.infer<typeof sheetAttackSchema>;

export const sheetSpellSchema = z.strictObject({
  id,
  name: z.string().min(1).max(200),
  level: z.number().int().min(0).max(9),
  prepared: z.boolean().default(false),
  /** Classe con cui si lancia (per CD e bonus di attacco); assente = la prima che lancia incantesimi. */
  classId: z.string().max(64).optional(),
  notes: noteText.default(""),
  contentId: id.optional(),
});
export type SheetSpell = z.infer<typeof sheetSpellSchema>;

export const sheetExtrasSchema = z.strictObject({
  notes: z.string().max(20000).default(""),
  inventory: z.array(sheetItemSchema).max(300).default([]),
  attacks: z.array(sheetAttackSchema).max(40).default([]),
  spells: z.array(sheetSpellSchema).max(400).default([]),
  /** Testo dello statblock (mostri): azioni, tratti... copiato dalla libreria importata. */
  statblockText: z.string().max(20000).default(""),
  /** Documento della libreria da cui è stata creata la scheda (facoltativo). */
  contentId: id.optional(),
});
export type SheetExtras = z.infer<typeof sheetExtrasSchema>;

export const sheetDocSchema = z
  .strictObject({
    sheet: characterSheetSchema,
    extras: sheetExtrasSchema.prefault({}),
  })
  .superRefine((doc, ctx) => {
    doc.sheet.classes.forEach((c, i) => {
      if (c.hitDie === undefined) {
        ctx.addIssue({ code: "custom", message: "Il dado vita è obbligatorio", path: ["sheet", "classes", i, "hitDie"] });
      }
    });
    const ids = doc.extras.inventory.map((i) => i.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "Oggetti con id duplicato", path: ["extras", "inventory"] });
    }
  });
export type SheetDoc = z.infer<typeof sheetDocSchema>;
export type SheetDocInput = z.input<typeof sheetDocSchema>;

export function parseSheetDoc(data: unknown): SheetDoc {
  return sheetDocSchema.parse(data);
}

/** Contenuti per il motore, ricavati dall'inventario del documento (le armature sono oggetti con `armor`). */
export function rulesContentFor(extras: SheetExtras): RulesContent {
  const armors: Record<string, ArmorDef> = {};
  for (const item of extras.inventory) {
    if (item.armor) {
      armors[item.id] = {
        category: item.armor.category,
        baseAc: item.armor.baseAc,
        ...(item.armor.strengthRequirement !== undefined ? { strengthRequirement: item.armor.strengthRequirement } : {}),
        ...(item.armor.stealthDisadvantage !== undefined ? { stealthDisadvantage: item.armor.stealthDisadvantage } : {}),
      };
    }
  }
  return { armors };
}

/** Peso totale (libbre) dell'inventario. */
export function inventoryWeight(extras: SheetExtras): number {
  const total = extras.inventory.reduce((n, i) => n + i.quantity * i.weight, 0);
  return Math.round(total * 100) / 100;
}

/**
 * Scheda pronta per il motore: peso trasportato dall'inventario e armatura sconosciuta ignorata
 * (l'oggetto potrebbe essere stato cancellato), così `derive` non lancia per colpa dei dati.
 */
export function engineSheet(doc: SheetDoc): { sheet: CharacterSheet; content: RulesContent } {
  const content = rulesContentFor(doc.extras);
  const armorId = doc.sheet.equipment.armorId;
  const equipment = armorId && !content.armors?.[armorId] ? { shield: doc.sheet.equipment.shield } : doc.sheet.equipment;
  const sheet: CharacterSheet = {
    ...doc.sheet,
    equipment,
    ...(doc.extras.inventory.length > 0 ? { carriedWeight: inventoryWeight(doc.extras) } : {}),
  };
  return { sheet, content };
}

export function deriveDoc(doc: SheetDoc): DerivedSheet {
  const { sheet, content } = engineSheet(doc);
  return derive(sheet, content);
}

/** Riepilogo di una scheda (nell'elenco e per la sincronizzazione con il token). */
export interface SheetSnapshot {
  level: number;
  hp: { current: number; max: number; temp: number };
  conditions: string[];
  exhaustion: number;
}

export function snapshotOf(doc: SheetDoc): SheetSnapshot {
  const { sheet, content } = engineSheet(doc);
  const d = derive(sheet, content);
  const hp = hpStateOf(sheet, content);
  return {
    level: d.level,
    hp: { current: hp.current, max: hp.max, temp: hp.temp },
    conditions: [...sheet.conditions, ...(sheet.exhaustion > 0 ? ["exhaustion"] : [])],
    exhaustion: sheet.exhaustion,
  };
}

/** Documento vuoto per un nuovo personaggio (livello 1, dado vita d8, caratteristiche 10). */
export function blankDoc(name = "", kind: "pc" | "monster" = "pc"): SheetDoc {
  return parseSheetDoc({
    sheet: {
      name,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      classes: [{ id: kind === "pc" ? "classe" : "mostro", level: 1, hitDie: 8 }],
    },
  });
}

const ABILITY_KEYS: Record<Ability, readonly string[]> = {
  str: ["str", "forza", "for"],
  dex: ["dex", "destrezza", "des"],
  con: ["con", "costituzione", "cos"],
  int: ["int", "intelligenza"],
  wis: ["wis", "saggezza", "sag"],
  cha: ["cha", "carisma", "car"],
};

function pickNumber(obj: Record<string, unknown>, keys: readonly string[], min: number, max: number): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    const n = typeof v === "number" ? v : typeof v === "object" && v && "average" in v ? (v as { average: unknown }).average : undefined;
    if (typeof n === "number" && Number.isFinite(n)) return Math.min(max, Math.max(min, Math.round(n)));
  }
  return undefined;
}

/**
 * Crea la scheda di un mostro da un documento importato (`kind: "monster"`). Il formato dei dati è
 * libero (docs/CONTENT.md): si riconoscono, se presenti, `hp`, `ac`, `speed`, le sei caratteristiche
 * (in `abilities` o al primo livello; nomi inglesi o italiani) e `text`. Il resto resta nel testo.
 * I PF massimi si ottengono con un dado vita fittizio e un bonus, così `derive` dà esattamente il valore importato.
 */
export function monsterDocFromContent(name: string, data: Record<string, unknown>, contentId?: string): SheetDoc {
  const nested = typeof data["abilities"] === "object" && data["abilities"] !== null ? (data["abilities"] as Record<string, unknown>) : {};
  const abilities = {} as Record<Ability, number>;
  for (const a of ABILITIES) {
    abilities[a] = pickNumber(nested, ABILITY_KEYS[a], 1, 30) ?? pickNumber(data, ABILITY_KEYS[a], 1, 30) ?? 10;
  }
  const conMod = Math.floor((abilities.con - 10) / 2);
  const hp = pickNumber(data, ["hp", "pf"], 1, 9999) ?? 1;
  const ac = pickNumber(data, ["ac", "ca"], 0, 40);
  const speed = pickNumber(data, ["speed", "velocita"], 0, 500);
  const dexMod = Math.floor((abilities.dex - 10) / 2);
  const text = typeof data["text"] === "string" ? data["text"] : "";
  return parseSheetDoc({
    sheet: {
      name: name.slice(0, 200),
      abilities,
      classes: [{ id: "mostro", level: 1, hitDie: 8 }],
      hpBonusPerLevel: hp - 8 - conMod,
      ...(ac !== undefined ? { acBonus: ac - (10 + dexMod) } : {}),
      ...(speed !== undefined ? { baseSpeed: speed } : {}),
    },
    extras: { statblockText: text.slice(0, 20000), ...(contentId ? { contentId } : {}) },
  });
}
