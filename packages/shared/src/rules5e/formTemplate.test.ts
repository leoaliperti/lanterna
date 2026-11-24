import { describe, expect, it } from "vitest";
import { FormError, FormTemplateSchema, applyFormEdit, blankDoc, formValues, readSource, writeSource, type FormTemplate } from "./index.js";

const field = (id: string, source: string, page = 0) => ({ id, page, x: 0.1, y: 0.1, w: 0.2, h: 0.05, source });
const template = (fields: ReturnType<typeof field>[]): FormTemplate => ({ version: 1, name: "Scheda del GM", pages: 3, fields });

describe("template del PDF del GM", () => {
  it("accetta un template valido", () => {
    const t = template([field("nome", "name"), field("str", "str.score")]);
    expect(FormTemplateSchema.safeParse(t).success).toBe(true);
  });

  it("rifiuta campi duplicati, pagine fuori dal PDF e sorgenti sconosciute", () => {
    expect(FormTemplateSchema.safeParse(template([field("a", "name"), field("a", "name")])).success).toBe(false);
    expect(FormTemplateSchema.safeParse(template([field("a", "name", 5)])).success).toBe(false);
    expect(FormTemplateSchema.safeParse(template([field("a", "non.esiste")])).success).toBe(false);
  });

  it("rifiuta un campo che esce dalla pagina", () => {
    const bad = { ...field("a", "name"), x: 0.9, w: 0.5 };
    expect(FormTemplateSchema.safeParse(template([bad])).success).toBe(false);
  });
});

describe("lettura delle sorgenti", () => {
  it("legge caratteristiche, competenza e bonus calcolati", () => {
    const doc = blankDoc("Aria");
    expect(readSource(doc, "name")).toBe("Aria");
    expect(readSource(doc, "str.score")).toBe(doc.sheet.abilities.str);
    expect(typeof readSource(doc, "ac")).toBe("number");
    expect(readSource(doc, "hitDice")).toMatch(/d\d+/);
  });

  it("una sorgente sconosciuta non legge nulla", () => {
    expect(readSource(blankDoc("x"), "inventato")).toBeNull();
  });

  it("formValues restituisce un valore per ogni campo del template", () => {
    const doc = blankDoc("Aria");
    const values = formValues(doc, template([field("nome", "name"), field("ca", "ac")]));
    expect(Object.keys(values).sort()).toEqual(["ca", "nome"]);
    expect(values.nome).toBe("Aria");
  });
});

describe("scrittura delle sorgenti", () => {
  it("scrive nome e caratteristica, e ricontrolla i limiti della scheda", () => {
    const doc = blankDoc("Aria");
    expect(writeSource(doc, "name", "Vela").sheet.name).toBe("Vela");
    expect(writeSource(doc, "str.score", 18).sheet.abilities.str).toBe(18);
    expect(() => writeSource(doc, "str.score", 31)).toThrow(FormError);
  });

  it("i campi di sola lettura non si scrivono", () => {
    expect(() => writeSource(blankDoc("x"), "ac", 20)).toThrow(/sola lettura/);
  });

  it("il tipo deve corrispondere alla sorgente", () => {
    expect(() => writeSource(blankDoc("x"), "str.score", "dodici" as unknown as number)).toThrow(FormError);
    expect(() => writeSource(blankDoc("x"), "str.score", 12.5)).toThrow(FormError);
  });

  it("competenza in un'abilità: solo sì o no, e il bonus cambia di conseguenza", () => {
    const doc = blankDoc("x");
    const before = readSource(doc, "acrobatics.bonus") as number;
    const on = writeSource(doc, "acrobatics.prof", true);
    expect(readSource(on, "acrobatics.prof")).toBe(true);
    expect(readSource(on, "acrobatics.bonus")).toBe(before + readSource(on, "prof")!);
  });

  it("i tre successi contro la morte si accendono e si spengono in ordine", () => {
    let doc = blankDoc("x");
    doc = writeSource(doc, "death.successes#2", true);
    expect(doc.sheet.hp.deathSaves.successes).toBe(2);
    doc = writeSource(doc, "death.successes#2", false);
    expect(doc.sheet.hp.deathSaves.successes).toBe(1);
  });

  it("applyFormEdit usa l'id del campo per trovare la sorgente", () => {
    const t = template([field("nome-pg", "name")]);
    expect(applyFormEdit(blankDoc("x"), t, "nome-pg", "Vela").sheet.name).toBe("Vela");
    expect(() => applyFormEdit(blankDoc("x"), t, "altro", "Vela")).toThrow(FormError);
  });

  it("scrive i testi narrativi e il profilo", () => {
    const doc = writeSource(blankDoc("x"), "traits", "Curioso");
    expect(doc.extras.profile.traits).toBe("Curioso");
    expect(() => writeSource(blankDoc("x"), "traits", "x".repeat(3000))).toThrow(FormError);
  });
});
