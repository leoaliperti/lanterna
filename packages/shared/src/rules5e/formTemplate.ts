/**
 * Modulo sovrapposto a un PDF del GM (scheda cartacea). Il PDF non è nel repo né nel pacchetto:
 * lo carica il GM nella sua istanza, e il template dice DOVE sta ogni campo e QUALE dato della
 * scheda mostra o modifica. Le posizioni sono normalizzate (0-1) rispetto alla pagina, quindi
 * valgono a ogni risoluzione.
 *
 * Una `source` è un nome del registro qui sotto (es. `str.score`, `skill.acrobatics.prof`,
 * `death.successes#2`). Il registro decide che cosa si legge e che cosa si può scrivere: tutto il
 * resto è di sola lettura o non esiste. La scrittura passa sempre da `sheetDocSchema`, quindi i
 * limiti della scheda valgono anche per il modulo.
 */
import { z } from "zod";
import { ABILITIES, SKILLS, attackBonus, type Ability, type Skill } from "./abilities.js";
import { deriveDoc, sheetDocSchema, type SheetDoc } from "./doc.js";
import { skillProficiency } from "./sheet.js";

export type FormValue = string | number | boolean;

interface SourceDef {
  kind: "text" | "number" | "bool";
  read: (doc: SheetDoc, d: ReturnType<typeof deriveDoc>) => FormValue | null;
  write?: (doc: SheetDoc, value: FormValue) => SheetDoc;
}

const ATTACK_SLOTS = 40;
const DEATH_SLOTS = 3;

function setSheet(doc: SheetDoc, patch: Partial<SheetDoc["sheet"]>): SheetDoc {
  return { ...doc, sheet: { ...doc.sheet, ...patch } };
}
function setProfile(doc: SheetDoc, patch: Partial<SheetDoc["extras"]["profile"]>): SheetDoc {
  return { ...doc, extras: { ...doc.extras, profile: { ...doc.extras.profile, ...patch } } };
}

const text = (get: (doc: SheetDoc) => string, set?: (doc: SheetDoc, v: string) => SheetDoc): SourceDef => ({
  kind: "text",
  read: (doc) => get(doc),
  ...(set ? { write: (doc, v) => set(doc, String(v)) } : {}),
});

/** Registro completo: id della sorgente → come si legge e (se previsto) come si scrive. */
export const FORM_SOURCES: Record<string, SourceDef> = {};

function add(id: string, def: SourceDef) {
  FORM_SOURCES[id] = def;
}

// --- Identità e livello (sola lettura, tranne il nome) ---
add("name", text((d) => d.sheet.name, (d, v) => setSheet(d, { name: v })));
add("class", text((d) => d.sheet.classes.map((c) => `${c.id} ${c.level}`).join(" / ")));
add("level", { kind: "number", read: (_d, der) => der.level });
add("prof", { kind: "number", read: (_d, der) => der.proficiencyBonus });
add("playerName", text((d) => d.extras.profile.playerName, (d, v) => setProfile(d, { playerName: v })));
add("race", text((d) => d.extras.profile.race, (d, v) => setProfile(d, { race: v })));
add("background", text((d) => d.extras.profile.background, (d, v) => setProfile(d, { background: v })));
add("alignment", text((d) => d.extras.profile.alignment, (d, v) => setProfile(d, { alignment: v })));
add("experience", {
  kind: "number",
  read: (d) => d.extras.profile.experience,
  write: (d, v) => setProfile(d, { experience: Number(v) }),
});
add("inspiration", {
  kind: "bool",
  read: (d) => d.extras.profile.inspiration,
  write: (d, v) => setProfile(d, { inspiration: Boolean(v) }),
});

// --- Caratteristiche e tiri salvezza ---
for (const a of ABILITIES as readonly Ability[]) {
  add(`${a}.score`, {
    kind: "number",
    read: (d) => d.sheet.abilities[a],
    write: (d, v) => setSheet(d, { abilities: { ...d.sheet.abilities, [a]: Number(v) } }),
  });
  add(`${a}.mod`, { kind: "number", read: (_d, der) => der.abilities[a].modifier });
  add(`${a}.save`, {
    kind: "number",
    read: (_d, der) => der.abilities[a].modifier + (der.abilities[a].save.proficient ? der.proficiencyBonus : 0),
  });
  add(`${a}.saveProf`, {
    kind: "bool",
    read: (d) => d.sheet.saveProficiencies.includes(a),
    write: (d, v) => {
      const without = d.sheet.saveProficiencies.filter((x) => x !== a);
      return setSheet(d, { saveProficiencies: v ? [...without, a] : without });
    },
  });
}

// --- Abilità: competenza sì/no (come nel modello) e bonus calcolato ---
for (const s of SKILLS as readonly Skill[]) {
  add(`${s}.prof`, {
    kind: "bool",
    read: (d) => skillProficiency(d.sheet.skills[s]) === "proficient",
    write: (d, v) => setSheet(d, { skills: { ...d.sheet.skills, [s]: v ? "proficient" : "none" } }),
  });
  add(`${s}.bonus`, { kind: "number", read: (_d, der) => der.skills[s].bonus });
}

// --- Combattimento e PF ---
add("ac", { kind: "number", read: (_d, der) => der.armorClass });
add("initiative", { kind: "number", read: (_d, der) => der.initiative.modifier });
add("speed", { kind: "number", read: (_d, der) => der.speed });
add("passive", { kind: "number", read: (_d, der) => der.passivePerception });
add("hp.max", { kind: "number", read: (_d, der) => der.hpMax });
add("hp.current", {
  kind: "number",
  read: (d, der) => Math.min(d.sheet.hp.current ?? der.hpMax, der.hpMax),
  write: (d, v) => setSheet(d, { hp: { ...d.sheet.hp, current: Number(v) } }),
});
add("hp.temp", {
  kind: "number",
  read: (d) => d.sheet.hp.temp,
  write: (d, v) => setSheet(d, { hp: { ...d.sheet.hp, temp: Number(v) } }),
});
add("hitDice", {
  kind: "text",
  read: (_d, der) =>
    Object.entries(der.hitDice)
      .map(([die, v]) => `${v.remaining}/${v.total} d${die}`)
      .join(", "),
});
for (let n = 1; n <= DEATH_SLOTS; n++) {
  add(`death.successes#${n}`, {
    kind: "bool",
    read: (d) => d.sheet.hp.deathSaves.successes >= n,
    write: (d, v) => setDeath(d, "successes", v ? n : n - 1),
  });
  add(`death.failures#${n}`, {
    kind: "bool",
    read: (d) => d.sheet.hp.deathSaves.failures >= n,
    write: (d, v) => setDeath(d, "failures", v ? n : n - 1),
  });
}
function setDeath(doc: SheetDoc, key: "successes" | "failures", value: number): SheetDoc {
  const ds = { ...doc.sheet.hp.deathSaves, [key]: Math.max(0, Math.min(DEATH_SLOTS, value)) };
  return setSheet(doc, { hp: { ...doc.sheet.hp, deathSaves: ds } });
}

// --- Testi narrativi (scrivibili) ---
for (const k of ["traits", "ideals", "bonds", "flaws", "story", "languages", "features"] as const) {
  add(k, text((d) => d.extras.profile[k], (d, v) => setProfile(d, { [k]: v })));
}

// --- Attacchi (fino a 40): nome, bonus calcolato, formula del danno, tipo ---
for (let i = 0; i < ATTACK_SLOTS; i++) {
  const at = (d: SheetDoc) => d.extras.attacks[i];
  const setAt = (d: SheetDoc, patch: Partial<NonNullable<ReturnType<typeof at>>>): SheetDoc => {
    const cur = d.extras.attacks[i];
    if (!cur) throw new Error(`attacco ${i + 1} non presente`);
    const attacks = d.extras.attacks.map((x, j) => (j === i ? { ...x, ...patch } : x));
    return { ...d, extras: { ...d.extras, attacks } };
  };
  add(`attack.${i}.name`, text((d) => at(d)?.name ?? "", (d, v) => setAt(d, { name: v })));
  add(`attack.${i}.bonus`, {
    kind: "number",
    read: (d, der) => {
      const a = at(d);
      if (!a) return null;
      return attackBonus(der.proficiencyBonus, der.abilities[a.ability as Ability].modifier, a.proficient, a.bonus);
    },
  });
  add(`attack.${i}.damage`, text((d) => at(d)?.damage ?? "", (d, v) => setAt(d, { damage: v })));
  add(`attack.${i}.type`, text((d) => at(d)?.damageType ?? "", (d, v) => setAt(d, { damageType: v })));
}

/** Valore di una sorgente per questa scheda (`null` se non c'è, es. attacco vuoto). */
export function readSource(doc: SheetDoc, source: string): FormValue | null {
  const def = FORM_SOURCES[source];
  if (!def) return null;
  return def.read(doc, deriveDoc(doc));
}

export function isWritableSource(source: string): boolean {
  return Boolean(FORM_SOURCES[source]?.write);
}

export class FormError extends Error {
  constructor(
    readonly code: "UNKNOWN_SOURCE" | "READONLY" | "INVALID",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Scrive il valore di una sorgente e restituisce la scheda nuova. Il tipo deve corrispondere al
 * registro; il risultato viene ricontrollato con lo schema della scheda (limiti, intervalli).
 */
export function writeSource(doc: SheetDoc, source: string, value: FormValue): SheetDoc {
  const def = FORM_SOURCES[source];
  if (!def) throw new FormError("UNKNOWN_SOURCE", `Sorgente sconosciuta: ${source}`);
  if (!def.write) throw new FormError("READONLY", `Campo di sola lettura: ${source}`);
  const typeOk =
    def.kind === "bool" ? typeof value === "boolean" : def.kind === "number" ? typeof value === "number" && Number.isInteger(value) : typeof value === "string";
  if (!typeOk) throw new FormError("INVALID", `Valore di tipo sbagliato per ${source}`);
  const next = def.write(doc, value);
  const checked = sheetDocSchema.safeParse(next);
  if (!checked.success) throw new FormError("INVALID", checked.error.issues[0]?.message ?? "Valore non valido");
  return checked.data;
}

// --- Template ---

export const FormFieldSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_.-]{1,60}$/, "Id del campo non valido"),
  page: z.number().int().min(0).max(19),
  /** Rettangolo normalizzato (0-1) sulla pagina. */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
  source: z.string().min(1).max(80),
});
export type FormField = z.infer<typeof FormFieldSchema>;

export const FormTemplateSchema = z
  .strictObject({
    version: z.literal(1),
    name: z.string().trim().min(1).max(120),
    /** Numero di pagine del PDF del GM (1-20). */
    pages: z.number().int().min(1).max(20),
    fields: z.array(FormFieldSchema).max(400),
  })
  .superRefine((t, ctx) => {
    const ids = new Set<string>();
    t.fields.forEach((f, i) => {
      if (ids.has(f.id)) ctx.addIssue({ code: "custom", message: `Campo duplicato: ${f.id}`, path: ["fields", i, "id"] });
      ids.add(f.id);
      if (f.page >= t.pages) ctx.addIssue({ code: "custom", message: `Pagina fuori dal PDF: ${f.id}`, path: ["fields", i, "page"] });
      if (f.x + f.w > 1 + 1e-9 || f.y + f.h > 1 + 1e-9) ctx.addIssue({ code: "custom", message: `Campo fuori pagina: ${f.id}`, path: ["fields", i] });
      if (!FORM_SOURCES[f.source]) ctx.addIssue({ code: "custom", message: `Sorgente sconosciuta: ${f.source}`, path: ["fields", i, "source"] });
    });
  });
export type FormTemplate = z.infer<typeof FormTemplateSchema>;

/** Valori di tutti i campi del template, per la scheda: il campo mostra quello che legge. */
export function formValues(doc: SheetDoc, template: FormTemplate): Record<string, FormValue | null> {
  const der = deriveDoc(doc);
  const out: Record<string, FormValue | null> = {};
  for (const f of template.fields) {
    const def = FORM_SOURCES[f.source];
    out[f.id] = def ? def.read(doc, der) : null;
  }
  return out;
}

/** Modifica il campo `fieldId` del template: scrive la sua sorgente e restituisce la scheda nuova. */
export function applyFormEdit(doc: SheetDoc, template: FormTemplate, fieldId: string, value: FormValue): SheetDoc {
  const field = template.fields.find((f) => f.id === fieldId);
  if (!field) throw new FormError("UNKNOWN_SOURCE", `Campo sconosciuto: ${fieldId}`);
  return writeSource(doc, field.source, value);
}
