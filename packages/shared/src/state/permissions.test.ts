import { describe, expect, it } from "vitest";
import type { Command, TokenPatch } from "./commands.js";
import type { ErrorCode } from "./errors.js";
import { GM, MAIN, P1, P2, PREP, SECRET, STRANGER, baseState, deepFreeze, scene, token } from "./fixtures.test-utils.js";
import { applyCommand } from "./reducer.js";
import type { Actor } from "./schema.js";

/**
 * Matrice dei permessi: azione x ruolo x relazione con il token.
 * Relazioni (dal punto di vista di P1):
 * - own:        token visibile di P1
 * - other:      token visibile di P2
 * - unowned:    token visibile senza proprietario (mostro)
 * - ownHidden:  token di P1 ma nascosto
 * - hidden:     token nascosto altrui
 * - otherScene: token su una scena non attiva
 * - missing:    id inesistente
 */
const TARGETS = {
  own: "tok-p1",
  other: "tok-p2",
  unowned: "tok-orc",
  ownHidden: SECRET.hiddenP1Id,
  hidden: SECRET.hiddenOgreId,
  otherScene: SECRET.prepDragonId,
  missing: "tok-non-esiste",
} as const;
type Target = keyof typeof TARGETS;
const TARGET_KEYS = Object.keys(TARGETS) as Target[];

type Outcome = "ok" | ErrorCode;

const PATCHES: Record<string, TokenPatch> = {
  name: { name: "Nuovo nome" },
  imageUrl: { imageUrl: "/assets/altro.png" },
  size: { size: 2 },
  rotation: { rotation: 90 },
  ownerUserId: { ownerUserId: "p2" },
  kind: { kind: "object" },
  hidden: { hidden: true },
  health: { health: { current: 1, max: 10, temp: 0 } },
  gmNotes: { gmNotes: "nota" },
  conditions: { conditions: [{ id: "stunned", name: "Stordito" }] },
};

function run(actor: Actor, cmd: Command): Outcome {
  const r = applyCommand(deepFreeze(baseState()), cmd, actor);
  return r.ok ? "ok" : r.error.code;
}

/** Esito atteso per un giocatore (P1) che agisce su un bersaglio. */
function playerExpected(target: Target, allowedOnOwn: boolean): Outcome {
  switch (target) {
    case "own":
      return allowedOnOwn ? "ok" : "FORBIDDEN";
    case "other":
    case "unowned":
      return "FORBIDDEN";
    // Invisibile o inesistente: SEMPRE NOT_FOUND, indistinguibili.
    case "ownHidden":
    case "hidden":
    case "otherScene":
    case "missing":
      return "NOT_FOUND";
  }
}

function gmExpected(target: Target): Outcome {
  return target === "missing" ? "NOT_FOUND" : "ok";
}

describe("matrice permessi: token.move", () => {
  for (const target of TARGET_KEYS) {
    const id = TARGETS[target];
    const cmd: Command = { type: "token.move", tokenId: id, x: 455, y: 455 };
    it(`GM -> ${target}`, () => expect(run(GM, cmd)).toBe(gmExpected(target)));
    it(`giocatore -> ${target}`, () => expect(run(P1, cmd)).toBe(playerExpected(target, true)));
  }
});

describe("matrice permessi: token.update per campo", () => {
  for (const [field, patch] of Object.entries(PATCHES)) {
    const playerAllowed = field === "conditions";
    for (const target of TARGET_KEYS) {
      const cmd: Command = { type: "token.update", tokenId: TARGETS[target], patch };
      it(`${field}: GM -> ${target}`, () => expect(run(GM, cmd)).toBe(gmExpected(target)));
      it(`${field}: giocatore -> ${target}`, () =>
        expect(run(P1, cmd)).toBe(playerExpected(target, playerAllowed)));
    }
  }

  it("una patch mista (condizioni + rotazione) è rifiutata per intero al giocatore", () => {
    const cmd: Command = {
      type: "token.update",
      tokenId: "tok-p1",
      patch: { conditions: [], rotation: 45 },
    };
    expect(run(P1, cmd)).toBe("FORBIDDEN");
  });
});

describe("matrice permessi: comandi solo GM", () => {
  const commands: Record<string, Command> = {
    "token.create": { type: "token.create", token: token("tok-nuovo", { ownerUserId: "p1" }) },
    "token.delete own": { type: "token.delete", tokenId: "tok-p1" },
    "token.delete hidden": { type: "token.delete", tokenId: SECRET.hiddenOgreId },
    "token.delete missing": { type: "token.delete", tokenId: "tok-non-esiste" },
    "scene.create": { type: "scene.create", scene: scene("scn-nuova") },
    "scene.update": { type: "scene.update", sceneId: MAIN, patch: { name: "X" } },
    "scene.setGrid": { type: "scene.setGrid", sceneId: MAIN, grid: { cellSize: 50 } },
    "scene.delete": { type: "scene.delete", sceneId: PREP },
    "scene.activate": { type: "scene.activate", sceneId: PREP },
    "scene.activate null": { type: "scene.activate", sceneId: null },
    "scene.setGrid missing": { type: "scene.setGrid", sceneId: "scn-x", grid: { snap: false } },
  };
  for (const [name, cmd] of Object.entries(commands)) {
    it(`${name}: GM`, () => expect(run(GM, cmd)).toBe(name.endsWith("missing") ? "NOT_FOUND" : "ok"));
    for (const actor of [P1, P2, STRANGER]) {
      // FORBIDDEN prima di guardare lo stato: non rivela se l'oggetto esiste.
      it(`${name}: ${actor.userId} -> FORBIDDEN`, () => expect(run(actor, cmd)).toBe("FORBIDDEN"));
    }
  }
});

describe("gli errori non distinguono nascosto da inesistente", () => {
  const variants: ((id: string) => Command)[] = [
    (id) => ({ type: "token.move", tokenId: id, x: 35, y: 35 }),
    (id) => ({ type: "token.update", tokenId: id, patch: { conditions: [] } }),
    (id) => ({ type: "token.update", tokenId: id, patch: { rotation: 10 } }),
    (id) => ({ type: "token.move", tokenId: id, x: -1, y: 99999 }),
  ];
  for (const [i, make] of variants.entries()) {
    it(`variante ${i}`, () => {
      const state = baseState();
      const results = [TARGETS.hidden, TARGETS.ownHidden, TARGETS.otherScene, TARGETS.missing].map((id) =>
        JSON.stringify(applyCommand(state, make(id), P1)),
      );
      expect(new Set(results).size).toBe(1);
      for (const r of results) {
        expect(r).not.toContain(SECRET.hiddenOgreId);
        expect(r).not.toContain(SECRET.hiddenOgreName);
      }
    });
  }
});

describe("proprietà che cambia", () => {
  it("dopo il passaggio di proprietà il vecchio proprietario non può più muovere", () => {
    let s = baseState();
    const r = applyCommand(s, { type: "token.update", tokenId: "tok-p1", patch: { ownerUserId: "p2" } }, GM);
    if (!r.ok) throw new Error(r.error.message);
    s = r.state;
    const m1 = applyCommand(s, { type: "token.move", tokenId: "tok-p1", x: 455, y: 455 }, P1);
    expect(m1.ok ? "ok" : m1.error.code).toBe("FORBIDDEN");
    const m2 = applyCommand(s, { type: "token.move", tokenId: "tok-p1", x: 455, y: 455 }, P2);
    expect(m2.ok).toBe(true);
  });

  it("un token rivelato torna muovibile dal proprietario", () => {
    const r = applyCommand(baseState(), { type: "token.update", tokenId: SECRET.hiddenP1Id, patch: { hidden: false } }, GM);
    if (!r.ok) throw new Error(r.error.message);
    expect(applyCommand(r.state, { type: "token.move", tokenId: SECRET.hiddenP1Id, x: 455, y: 455 }, P1).ok).toBe(true);
  });

  it("un token sulla scena preparata diventa raggiungibile quando la scena è attivata", () => {
    const owned = applyCommand(baseState(), { type: "token.update", tokenId: SECRET.prepDragonId, patch: { ownerUserId: "p1" } }, GM);
    if (!owned.ok) throw new Error();
    const cmd: Command = { type: "token.move", tokenId: SECRET.prepDragonId, x: 455, y: 455 };
    expect(applyCommand(owned.state, cmd, P1).ok).toBe(false);
    const act = applyCommand(owned.state, { type: "scene.activate", sceneId: PREP }, GM);
    if (!act.ok) throw new Error();
    expect(applyCommand(act.state, cmd, P1).ok).toBe(true);
  });
});
