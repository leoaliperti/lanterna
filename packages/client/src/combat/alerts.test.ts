import { afterEach, describe, expect, it, vi } from "vitest";
import type { CombatAlert } from "../realtime/RealtimeClient";
import { AlertDeduper, alertKey, presentAlert } from "./alerts";
import { EphemeralStore, shapesOfScene } from "./ephemeralStore";

const turn = (round: number, participantId = "p1"): CombatAlert => ({ type: "combat.turn", sceneId: "s1", round, participantId, tokenId: "t1" });
const expiring: CombatAlert = { type: "effect.expiring", sceneId: "s1", round: 2, tokenId: "t1", effectId: "e1", name: "Fiamma", remaining: 1 };
const expired: CombatAlert = { type: "effect.expired", sceneId: "s1", round: 3, tokenId: "t1", effectId: "e1", name: "Fiamma", reason: "elapsed" };

describe("avvisi del combattimento", () => {
  it("scarta lo stesso avviso nello stesso round (dopo la riconnessione) ma non quelli di un altro round", () => {
    const d = new AlertDeduper();
    expect(d.accept(turn(2))).toBe(true);
    expect(d.accept(turn(2))).toBe(false);
    expect(d.accept(turn(3))).toBe(true);
    expect(d.accept(turn(3, "p2"))).toBe(true);
    expect(d.accept(expiring)).toBe(true);
    expect(d.accept({ ...expiring })).toBe(false);
    expect(d.accept(expired)).toBe(true);
    expect(d.accept({ ...expired, reason: "combatEnded" })).toBe(true);
    d.reset();
    expect(d.accept(turn(2))).toBe(true);
    expect(alertKey(turn(2))).not.toBe(alertKey(turn(3)));
  });

  it("tiene la memoria limitata", () => {
    const d = new AlertDeduper(3);
    for (let r = 1; r <= 5; r++) d.accept(turn(r));
    expect(d.accept(turn(1))).toBe(true); // gia' dimenticato
    expect(d.accept(turn(5))).toBe(false); // recente: ancora ricordato
  });

  it("e' discreto: toast breve e richiamo sul token, niente di bloccante", () => {
    const tokens = [{ id: "t1", name: "Aldo" }];
    const a = presentAlert(turn(4), tokens);
    expect(a.toast.title).toBe("Tocca a Aldo");
    expect(a.toast.message).toBe("Round 4");
    expect(a.toast.duration).toBeLessThanOrEqual(4000);
    expect(a.pulse).toEqual({ tokenId: "t1", kind: "turn" });
    expect(presentAlert(expiring, tokens)).toMatchObject({ toast: { tone: "warning" }, pulse: { kind: "warn" } });
    expect(presentAlert(expired, tokens).pulse?.kind).toBe("expired");
    expect(presentAlert({ ...expired, reason: "combatEnded" }, tokens).toast.message).toContain("combattimento");
    const free: CombatAlert = { type: "combat.turn", sceneId: "s1", round: 1, participantId: "p3", tokenId: null };
    expect(presentAlert(free, tokens, "Trappola").pulse).toBeNull();
  });
});

describe("forme effimere", () => {
  afterEach(() => vi.useRealTimers());

  it("scadono dopo il ttl e si possono sostituire e togliere", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const store = new EphemeralStore();
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().length));
    store.receive({ type: "ephemeral.shown", id: "m1", authorId: "gm", sceneId: "s1", ttlMs: 2000, shape: { kind: "ping", x: 1, y: 2 } });
    store.receive({ type: "ephemeral.shown", id: "m2", authorId: "gm", sceneId: "s1", ttlMs: 6000, shape: { kind: "cells", cells: [1, 1] } });
    expect(store.getSnapshot()).toHaveLength(2);
    // Stesso autore e stesso id: sostituisce.
    store.receive({ type: "ephemeral.shown", id: "m1", authorId: "gm", sceneId: "s1", ttlMs: 2000, shape: { kind: "ping", x: 5, y: 5 } });
    expect(store.getSnapshot()).toHaveLength(2);
    // Stesso id ma altro autore: forma diversa.
    store.receive({ type: "ephemeral.shown", id: "m1", authorId: "luca", sceneId: "s1", ttlMs: 2000, shape: { kind: "ping", x: 9, y: 9 } });
    expect(store.getSnapshot()).toHaveLength(3);
    vi.advanceTimersByTime(2100);
    expect(store.getSnapshot().map((s) => s.key)).toEqual(["gm:m2"]);
    store.receive({ type: "ephemeral.cleared", id: "m2", authorId: "gm" });
    expect(store.getSnapshot()).toHaveLength(0);
    store.dispose();
  });

  it("filtra per scena e converte in forme per la mappa", () => {
    const store = new EphemeralStore(() => 100);
    store.add({ id: "a", authorId: "x", sceneId: "s1", shape: { kind: "circle", x: 1, y: 1, radius: 5 }, ttlMs: 1000, color: "#ff0000" });
    store.add({ id: "b", authorId: "x", sceneId: "s2", shape: { kind: "ping", x: 1, y: 1 }, ttlMs: 1000 });
    const list = shapesOfScene(store.getSnapshot(), "s1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: "x:a", color: "#ff0000", expiresAt: 1100, ttlMs: 1000 });
    expect(shapesOfScene(store.getSnapshot(), null)).toEqual([]);
    store.dispose();
  });
});
