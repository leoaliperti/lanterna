import { describe, expect, it } from "vitest";
import { blankDoc, damageSheet, deriveDoc, parseSheetDoc, type SheetDoc, type SheetSummary, type TokenView } from "@lanterna/shared";
import { itemFromContent, spellFromContent } from "./fromContent";
import { applySheetOp, formulaOf, matchesQuery, normalize, planTokenSync, rollTargetFor, signed } from "./sheetLogic";

/* Dati FITTIZI: nessun contenuto di manuali. */

function hero(over: Partial<SheetDoc["sheet"]> = {}): SheetDoc {
  const d = blankDoc("Eroe di prova");
  return { ...d, sheet: { ...d.sheet, abilities: { ...d.sheet.abilities, dex: 14, wis: 12 }, skills: { perception: "proficient", stealth: "expertise" }, ...over } };
}

describe("ricerca", () => {
  it("ignora maiuscole e accenti e vuole tutte le parole", () => {
    expect(normalize("Rapidità di Mano")).toBe("rapidita di mano");
    expect(matchesQuery("rapidita", "Rapidita' di mano")).toBe(true);
    expect(matchesQuery("furt per", "Furtivita'", "Percezione")).toBe(true);
    expect(matchesQuery("xyz", "Furtivita'")).toBe(false);
    expect(matchesQuery("  ", "qualsiasi")).toBe(true);
  });
});

describe("formula dei tiri", () => {
  it("modificatori e competenza dalla scheda", () => {
    const doc = hero();
    expect(formulaOf(rollTargetFor(doc, { kind: "skill", skill: "perception" }))).toBe("1d20+3");
    // Competenza in Furtività: solo il bonus di competenza (nessuna maestria).
    expect(formulaOf(rollTargetFor(doc, { kind: "skill", skill: "stealth" }))).toBe("1d20+4");
    expect(formulaOf(rollTargetFor(doc, { kind: "check", ability: "str" }))).toBe("1d20");
    expect(signed(-2)).toBe("−2");
  });

  it("le condizioni danno svantaggio e il fallimento automatico non si tira", () => {
    const poisoned = hero({ conditions: ["poisoned"] });
    expect(formulaOf(rollTargetFor(poisoned, { kind: "skill", skill: "perception" }))).toBe("1d20+3 dis");
    expect(formulaOf(rollTargetFor(poisoned, { kind: "attack", ability: "dex" }))).toBe("1d20+4 dis");
    const stunned = hero({ conditions: ["stunned"] });
    expect(formulaOf(rollTargetFor(stunned, { kind: "save", ability: "dex" }))).toBeNull();
  });

  it("l'esaurimento riduce i tiri di 2 per livello", () => {
    expect(formulaOf(rollTargetFor(hero({ exhaustion: 2 }), { kind: "skill", skill: "perception" }))).toBe("1d20-1");
  });
});

describe("operazioni sul documento", () => {
  it("il danno passa dal motore e si copia solo cio' che cambia", () => {
    const base = parseSheetDoc({ ...hero(), extras: { inventory: [{ id: "a", name: "Zaino", weight: 5 }] } });
    const next = applySheetOp(base, (s, c) => damageSheet(s, c, 5));
    expect(next.sheet.hp.current).toBe(3);
    // Il peso risolto dal motore non finisce nei dati salvati.
    expect(next.sheet.carriedWeight).toBeUndefined();
    expect(next.extras).toEqual(base.extras);
    expect(deriveDoc(next).hpMax).toBe(8);
  });
});

describe("dalla libreria", () => {
  it("riconosce solo i campi noti e limita i valori", () => {
    const spell = spellFromContent({ id: "c1", name: "Scintilla di prova", data: { level: 14, text: "Testo inventato." } });
    expect(spell).toMatchObject({ name: "Scintilla di prova", level: 9, notes: "Testo inventato.", contentId: "c1" });
    const item = itemFromContent({ id: "c2", name: "Corazza di prova", data: { weight: 20, armor: { category: "medium", baseAc: 14 } } });
    expect(item.armor).toEqual({ category: "medium", baseAc: 14 });
    expect(item.weight).toBe(20);
    expect(itemFromContent({ id: "c3", name: "x", data: { armor: { category: "boh" } } }).armor).toBeUndefined();
    expect(() => parseSheetDoc({ ...blankDoc(), extras: { inventory: [item], spells: [spell] } })).not.toThrow();
  });
});

describe("sincronizzazione scheda -> token", () => {
  const sheet = (over: Partial<SheetSummary> = {}): SheetSummary => ({
    id: "s1",
    campaignId: "c1",
    kind: "pc",
    name: "Eroe",
    ownerUserId: "luca",
    tokenId: "t1",
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    level: 1,
    hp: { current: 8, max: 8, temp: 0 },
    conditions: [],
    exhaustion: 0,
    ...over
  });
  const token = (over: Partial<TokenView> = {}) =>
    ({ id: "t1", conditions: [{ id: "custom", name: "Benedetto" }], health: { current: 8, max: 8, temp: 0 }, ...over }) as TokenView;

  it("la prima osservazione non sovrascrive la barra del token", () => {
    const r = planTokenSync(new Map(), [sheet({ hp: { current: 2, max: 8, temp: 0 } })], [token()]);
    expect(r.updates).toEqual([]);
  });

  it("un cambio di PF o condizioni copia PF e condizioni 5e e conserva quelle personalizzate", () => {
    const first = planTokenSync(new Map(), [sheet()], [token()]);
    const r = planTokenSync(first.next, [sheet({ hp: { current: 3, max: 8, temp: 2 }, conditions: ["poisoned"] })], [token()]);
    expect(r.updates).toEqual([
      {
        tokenId: "t1",
        patch: {
          health: { current: 3, max: 8, temp: 2 },
          conditions: [
            { id: "custom", name: "Benedetto" },
            { id: "poisoned", name: "Avvelenato" }
          ]
        }
      }
    ]);
    // Nessuna ripetizione finche' la scheda non cambia di nuovo (il GM puo' ritoccare la barra).
    expect(planTokenSync(r.next, [sheet({ hp: { current: 3, max: 8, temp: 2 }, conditions: ["poisoned"] })], [token({ health: { current: 7, max: 8, temp: 0 } })]).updates).toEqual([]);
  });

  it("un token senza barra la riceve subito; senza token o senza legame non si fa nulla", () => {
    expect(planTokenSync(new Map(), [sheet()], [token({ health: null })]).updates).toHaveLength(1);
    expect(planTokenSync(new Map(), [sheet({ tokenId: null })], [token({ health: null })]).updates).toEqual([]);
    expect(planTokenSync(new Map(), [sheet({ tokenId: "assente" })], [token({ health: null })]).updates).toEqual([]);
  });
});
