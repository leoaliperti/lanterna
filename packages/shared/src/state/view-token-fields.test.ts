import { describe, expect, it } from "vitest";
import { projectToken } from "./view.js";
import { GM, P1, token } from "./fixtures.test-utils.js";

/** La proiezione copia i campi uno per uno: forma e numero (visibili a tutti) devono arrivare a ogni vista. */
describe("proiezione del token: forma e numero", () => {
  it("il numero e la forma arrivano a GM e giocatori, e spariscono se assenti", () => {
    const t = { ...token("t1", { x: 0, y: 0 }), shape: "square" as const, number: 7 };
    expect(projectToken(t, GM)).toMatchObject({ shape: "square", number: 7 });
    expect(projectToken(t, P1)).toMatchObject({ shape: "square", number: 7 });
    const bare = token("t2", { x: 0, y: 0 });
    expect(projectToken(bare, P1)).not.toHaveProperty("number");
    expect(projectToken(bare, P1)).not.toHaveProperty("shape");
  });
});
