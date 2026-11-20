import { describe, expect, it } from "vitest";
import {
  blankDoc,
  deriveDoc,
  engineSheet,
  inventoryWeight,
  monsterDocFromContent,
  parseSheetDoc,
  sheetDocSchema,
  snapshotOf,
} from "./doc.js";

describe("documento della scheda", () => {
  it("il documento vuoto è valido e derivabile", () => {
    const doc = blankDoc("Prova");
    expect(deriveDoc(doc).level).toBe(1);
    expect(snapshotOf(doc).hp).toEqual({ current: 8, max: 8, temp: 0 });
  });

  it("rifiuta classi senza dado vita, campi sconosciuti e id oggetto duplicati", () => {
    const base = { sheet: { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, classes: [{ id: "x", level: 1 }] } };
    expect(sheetDocSchema.safeParse(base).success).toBe(false);
    expect(sheetDocSchema.safeParse({ ...blankDoc(), extra: 1 }).success).toBe(false);
    const dup = { ...blankDoc(), extras: { inventory: [{ id: "a", name: "A" }, { id: "a", name: "B" }] } };
    expect(sheetDocSchema.safeParse(dup).success).toBe(false);
  });

  it("l'armatura viene dall'inventario e un'armatura cancellata non fa lanciare derive", () => {
    const doc = parseSheetDoc({
      ...blankDoc("A"),
      sheet: { ...blankDoc("A").sheet, equipment: { armorId: "arm", shield: false } },
      extras: { inventory: [{ id: "arm", name: "Armatura di prova", armor: { category: "heavy", baseAc: 16 } }] },
    });
    expect(deriveDoc(doc).armorClass).toBe(16);
    const gone = { ...doc, extras: { ...doc.extras, inventory: [] } };
    expect(deriveDoc(gone).armorClass).toBe(10);
  });

  it("il peso arriva dall'inventario", () => {
    const doc = parseSheetDoc({
      ...blankDoc(),
      extras: { inventory: [{ id: "a", name: "A", quantity: 3, weight: 2.5 }] },
    });
    expect(inventoryWeight(doc.extras)).toBe(7.5);
    expect(engineSheet(doc).sheet.carriedWeight).toBe(7.5);
  });

  it("monsterDocFromContent riproduce PF e CA importati", () => {
    const doc = monsterDocFromContent("Gufo di prova", { hp: 37, ac: 14, speed: 40, str: 8, dex: 14, con: 12, text: "Testo inventato." });
    const d = deriveDoc(doc);
    expect(d.hpMax).toBe(37);
    expect(d.armorClass).toBe(14);
    expect(d.speed).toBe(40);
    expect(doc.extras.statblockText).toBe("Testo inventato.");
    const other = monsterDocFromContent("X", { abilities: { forza: 20, con: 6 }, hp: { average: 5 } });
    expect(deriveDoc(other).abilities.str.score).toBe(20);
    expect(deriveDoc(other).hpMax).toBe(5);
  });
});
