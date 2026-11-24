import { describe, expect, it } from "vitest";
import { TokenConditionSchema, TokenNumberSchema, TokenShapeSchema } from "./schema.js";
import { TokenPatchSchema } from "./commands.js";

describe("forma, numero e livello di esaurimento del token", () => {
  it("le forme ammesse sono quelle della tavolozza, niente altro", () => {
    for (const s of ["circle", "square", "diamond", "hexagon", "triangle"]) expect(TokenShapeSchema.safeParse(s).success).toBe(true);
    expect(TokenShapeSchema.safeParse("star").success).toBe(false);
  });

  it("il numero del token è un intero 0-999", () => {
    expect(TokenNumberSchema.safeParse(0).success).toBe(true);
    expect(TokenNumberSchema.safeParse(999).success).toBe(true);
    expect(TokenNumberSchema.safeParse(1000).success).toBe(false);
    expect(TokenNumberSchema.safeParse(1.5).success).toBe(false);
  });

  it("una patch può cambiare forma e numero (anche togliere il numero)", () => {
    expect(TokenPatchSchema.safeParse({ shape: "hexagon", number: 3 }).success).toBe(true);
    expect(TokenPatchSchema.safeParse({ number: null }).success).toBe(true);
  });

  it("l'esaurimento accetta un livello da 1 a 6, le altre condizioni no", () => {
    expect(TokenConditionSchema.safeParse({ id: "exhaustion", name: "Esaurimento", level: 6 }).success).toBe(true);
    expect(TokenConditionSchema.safeParse({ id: "exhaustion", name: "Esaurimento", level: 7 }).success).toBe(false);
    expect(TokenConditionSchema.safeParse({ id: "exhaustion", name: "Esaurimento", level: 0 }).success).toBe(false);
    expect(TokenConditionSchema.safeParse({ id: "prone", name: "Prono" }).success).toBe(true);
  });
});
