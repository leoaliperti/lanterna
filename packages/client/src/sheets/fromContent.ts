import type { SheetItem, SheetSpell } from "@lanterna/shared";
import { newId } from "./sheetLogic";

/* Dalla libreria importata alla scheda. I formati dei dati importati sono liberi (docs/CONTENT.md):
   si riconoscono solo i campi elencati, il resto resta nella libreria. */

function num(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

export interface ContentLike {
  id: string;
  name: string;
  data: Record<string, unknown>;
}

/** Incantesimo importato -> voce della scheda. Si riconoscono `level` e `text`. */
export function spellFromContent(doc: ContentLike): SheetSpell {
  return {
    id: newId(),
    name: doc.name.slice(0, 200),
    level: Math.round(num(doc.data["level"], 0, 9, 0)),
    prepared: false,
    notes: text(doc.data["text"], 2000),
    contentId: doc.id
  };
}

/** Oggetto importato -> voce dell'inventario. Si riconoscono `weight`, `text` e, per le armature, `armor: { category, baseAc }`. */
export function itemFromContent(doc: ContentLike): SheetItem {
  const armor = doc.data["armor"];
  let armorDef: SheetItem["armor"];
  if (armor && typeof armor === "object") {
    const a = armor as Record<string, unknown>;
    const category = a["category"];
    if (category === "light" || category === "medium" || category === "heavy") {
      armorDef = { category, baseAc: Math.round(num(a["baseAc"], 0, 30, 10)) };
    }
  }
  return {
    id: newId(),
    name: doc.name.slice(0, 200),
    quantity: 1,
    weight: num(doc.data["weight"], 0, 10000, 0),
    equipped: false,
    notes: text(doc.data["text"], 2000),
    contentId: doc.id,
    ...(armorDef ? { armor: armorDef } : {})
  };
}
