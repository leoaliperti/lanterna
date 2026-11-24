import { describe, expect, it } from "vitest";
import { sourceLabel } from "./sourceLabels";

describe("etichette delle sorgenti", () => {
  it("usa il nome italiano per i campi fissi e per caratteristiche e abilità", () => {
    expect(sourceLabel("name")).toBe("Nome personaggio");
    expect(sourceLabel("str.score")).toBe("Forza · punteggio");
    expect(sourceLabel("acrobatics.prof")).toBe("Acrobazia · competenza");
    expect(sourceLabel("acrobatics.bonus")).toBe("Acrobazia · bonus");
  });

  it("nomina i tre cerchi della morte e gli attacchi con il numero della riga", () => {
    expect(sourceLabel("death.successes#2")).toBe("Tiro contro la morte, successo 2");
    expect(sourceLabel("attack.0.damage")).toBe("Attacco 1 · danno");
  });

  it("per un id sconosciuto torna l'id", () => {
    expect(sourceLabel("inventato.xyz")).toBe("inventato.xyz");
  });
});
