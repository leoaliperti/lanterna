import { describe, expect, it } from "vitest";
import { GM, MAIN, P1, PREP, baseState } from "../state/fixtures.test-utils.js";
import { defaultTtlMs, validateEphemeral } from "./ephemeral.js";
import { parseClientMessage } from "./messages.js";

const show = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "ephemeral.show", requestId: "r1", id: "m1", sceneId: MAIN, audience: "all", shape: { kind: "ping", x: 10, y: 10 }, ...over });

describe("messaggi effimeri", () => {
  it("accetta forme valide e rifiuta quelle non valide", () => {
    expect(parseClientMessage(show()).ok).toBe(true);
    expect(parseClientMessage(show({ audience: "gm", ttlMs: 2000, color: "#ff0000" })).ok).toBe(true);
    for (const bad of [
      { audience: "tutti" },
      { ttlMs: 10 },
      { ttlMs: 31_000 },
      { ttlMs: 1.5 },
      { color: "rosso" },
      { shape: { kind: "circle", x: 1, y: 1, radius: -1 } },
      { id: "con spazi" },
      { extra: 1 },
    ]) {
      expect(parseClientMessage(show(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(parseClientMessage(JSON.stringify({ type: "ephemeral.clear", requestId: "r", id: "m1" })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: "ephemeral.clear", requestId: "r" })).ok).toBe(false);
  });

  it("initiative.roll: bonus e modo validi", () => {
    const msg = (rolls: unknown, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ type: "initiative.roll", requestId: "r", sceneId: MAIN, rolls, ...extra });
    expect(parseClientMessage(msg([{ participantId: "p", bonus: 3 }, { participantId: "q", bonus: -1, mode: "advantage" }], { sort: true })).ok).toBe(true);
    expect(parseClientMessage(msg([])).ok).toBe(false);
    expect(parseClientMessage(msg([{ participantId: "p", bonus: 1.5 }])).ok).toBe(false);
    expect(parseClientMessage(msg([{ participantId: "p", bonus: 999 }])).ok).toBe(false);
    expect(parseClientMessage(msg([{ participantId: "p", bonus: 1, mode: "boh" }])).ok).toBe(false);
  });

  it("durata predefinita per tipo", () => {
    expect(defaultTtlMs({ kind: "ping", x: 1, y: 1 })).toBeLessThan(defaultTtlMs({ kind: "circle", x: 1, y: 1, radius: 3 }));
  });

  it("validateEphemeral: il giocatore solo sulla scena attiva e dentro la mappa", () => {
    const s = baseState();
    const shape = { kind: "ping", x: 10, y: 10 } as const;
    expect(validateEphemeral(s, P1, { sceneId: MAIN, shape })).toMatchObject({ ok: true });
    expect(validateEphemeral(s, P1, { sceneId: PREP, shape })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(validateEphemeral(s, P1, { sceneId: "ghost", shape })).toEqual(validateEphemeral(s, P1, { sceneId: PREP, shape }));
    expect(validateEphemeral(s, GM, { sceneId: PREP, shape })).toMatchObject({ ok: true });
    expect(validateEphemeral(s, P1, { sceneId: MAIN, shape: { kind: "ping", x: 5000, y: 10 } })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(validateEphemeral(s, P1, { sceneId: MAIN, shape: { kind: "ruler", points: [{ x: 1, y: 1 }, { x: 99999, y: 1 }] } })).toMatchObject({ ok: false });
  });
});
