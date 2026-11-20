import { describe, expect, it } from "vitest";
import { applyServerEvent } from "../protocol/client.js";
import { filterEventsFor } from "./filter.js";
import { GM, MAIN, P1, P2, STRANGER, deepFreeze, rng, scene, token } from "./fixtures.test-utils.js";
import { createHistory, execute, redo, undo, type History, type HistoryResult } from "./history.js";
import { checkInvariants } from "./invariants.js";
import { CampaignStateSchema, combatOf, type Actor, type CampaignState } from "./schema.js";
import { viewFor, type CampaignView } from "./view.js";

/**
 * Fuzz del combattimento (M7): sequenze casuali ma riproducibili di comandi di iniziativa, turni, effetti,
 * gruppi e azioni di gruppo (validi, quasi validi e spazzatura) da attori casuali, con annulla/ripeti.
 * A ogni passo: nessuna eccezione, invarianti dello stato (round/turno coerenti), input non mutato,
 * nessuna fuga ai giocatori e i delta ricostruiscono esattamente `viewFor`.
 */

const SEEDS = [1, 7, 42, 99, 1234, 2025, 31337, 777777];
const STEPS = 700;
const OTHER = "scn-altra";
const SECRET_NAMES = ["Segreto-A", "Segreto-B"];
const tk = (n: number) => `tk-${n}`;
const pt = (n: number) => `pt-${n}`;
const ef = (n: number) => `ef-${n}`;
const gr = (n: number) => `gr-${n}`;

function initial(): CampaignState {
  const tokens = Array.from({ length: 10 }, (_, i) =>
    token(tk(i), {
      name: i % 4 === 3 ? `${SECRET_NAMES[i % 2]}-${i}` : `Nome-${i}`,
      x: 70 + i * 100,
      y: 70 + (i % 3) * 140,
      hidden: i % 4 === 3,
      kind: i % 3 === 0 ? "pc" : "monster",
      ownerUserId: i === 0 ? "p1" : i === 1 ? "p2" : null,
      health: i % 5 === 4 ? null : { current: 10 + i, max: 30, temp: i % 2 },
      ...(i % 2 === 0 ? { faction: "banda" } : {}),
    }),
  );
  return CampaignStateSchema.parse({
    campaignId: "camp-cf",
    name: "Fuzz combattimento",
    version: 0,
    activeSceneId: MAIN,
    members: [
      { userId: "gm1", displayName: "Master", role: "admin" },
      { userId: "p1", displayName: "Alice", role: "player" },
      { userId: "p2", displayName: "Bruno", role: "player" },
    ],
    scenes: [scene(MAIN), scene(OTHER)],
    tokens,
  });
}

function generator(r: () => number) {
  const int = (n: number) => Math.floor(r() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  const anyTk = () => (r() < 0.05 ? "ghost" : tk(int(11)));
  const scn = () => (r() < 0.85 ? MAIN : pick([OTHER, "nessuna"]));
  const init = () => (r() < 0.1 ? pick<unknown>([null, 5000, -5000, "x", Number.NaN]) : int(30));
  const effectInput = () => ({
    id: ef(int(6)),
    name: `Eff-${int(5)}`,
    condition: r() < 0.5 ? null : pick([{ id: "stunned", name: "Stordito" }, { id: "prone", name: "Prono" }, { id: "poisoned", name: "Avvelenato" }]),
    remaining: r() < 0.2 ? null : r() < 0.05 ? 0 : 1 + int(3),
    timing: pick(["start", "end"]),
    turnOf: r() < 0.6 ? null : anyTk(),
    secret: r() < 0.2,
  });
  const target = (): unknown =>
    pick<unknown>([
      { kind: "tokens", tokenIds: Array.from({ length: 1 + int(3) }, anyTk) },
      { kind: "group", groupId: gr(int(4)) },
      { kind: "category", sceneId: scn(), ...(r() < 0.5 ? { tokenKind: pick(["pc", "monster", "object"]) } : {}), ...(r() < 0.3 ? { faction: "banda" } : {}) },
      { kind: "tokens", tokenIds: [] },
      { kind: "nope" },
    ]);
  const action = (): unknown =>
    pick<unknown>([
      { kind: "damage", amount: int(40), ...(r() < 0.3 ? { critical: true } : {}) },
      { kind: "heal", amount: int(20) },
      { kind: "tempHp", amount: int(10) },
      { kind: "addCondition", condition: pick([{ id: "prone", name: "Prono" }, { id: "blinded", name: "Accecato" }]) },
      { kind: "removeCondition", conditionId: pick(["prone", "blinded", "dead", "unconscious"]) },
      { kind: "addEffect", effect: effectInput() },
      { kind: "move", dx: int(300) - 150, dy: int(300) - 150 },
      { kind: "damage", amount: -3 },
    ]);

  function command(): unknown {
    switch (int(24)) {
      case 0:
      case 1:
      case 2:
        return {
          type: "combat.add",
          sceneId: scn(),
          participant: { id: pt(int(14)), tokenId: r() < 0.7 ? anyTk() : null, name: r() < 0.7 ? `Libero-${int(5)}` : null, initiative: init(), hidden: r() < 0.2, hideInitiative: r() < 0.2 },
        };
      case 3:
        return { type: "combat.update", sceneId: scn(), participantId: pt(int(14)), patch: pick<unknown>([{ initiative: init() }, { hidden: r() < 0.5 }, { hideInitiative: r() < 0.5 }, { name: "Nome" }, {}]) };
      case 4:
        return { type: "combat.remove", sceneId: scn(), participantId: pt(int(14)) };
      case 5:
        return { type: "combat.reorder", sceneId: scn(), participantId: pt(int(14)), toIndex: int(10) };
      case 6:
        return { type: "combat.setInitiative", sceneId: scn(), values: [{ participantId: pt(int(14)), initiative: init() }, { participantId: pt(int(14)), initiative: init() }], ...(r() < 0.5 ? { sort: true } : {}) };
      case 7:
        return { type: "combat.sort", sceneId: scn() };
      case 8:
        return { type: "combat.start", sceneId: scn(), ...(r() < 0.3 ? { sort: true } : {}) };
      case 9:
      case 10:
      case 11:
      case 12:
        return { type: "combat.next", sceneId: scn() };
      case 13:
        return { type: "combat.previous", sceneId: scn() };
      case 14:
        return r() < 0.3 ? { type: "combat.end", sceneId: scn() } : { type: "combat.next", sceneId: MAIN };
      case 15:
      case 16:
        return { type: "effect.add", tokenId: anyTk(), effect: effectInput() };
      case 17:
        return r() < 0.5
          ? { type: "effect.remove", tokenId: anyTk(), effectId: ef(int(6)) }
          : { type: "effect.update", tokenId: anyTk(), effectId: ef(int(6)), patch: pick<unknown>([{ remaining: 1 + int(3) }, { secret: r() < 0.5 }, { name: "X" }, { remaining: null }]) };
      case 18:
        return { type: "group.create", group: { id: gr(int(4)), name: `Gruppo-${int(3)}`, tokenIds: Array.from({ length: int(4) }, anyTk) } };
      case 19:
        return r() < 0.5
          ? { type: "group.update", groupId: gr(int(4)), patch: pick<unknown>([{ name: "G" }, { tokenIds: [anyTk(), anyTk()] }]) }
          : { type: "group.delete", groupId: gr(int(4)) };
      case 20:
      case 21:
      case 22:
        return { type: "group.apply", target: target(), action: action() };
      default:
        return pick<unknown>([
          { type: "token.delete", tokenId: anyTk() },
          { type: "token.update", tokenId: anyTk(), patch: pick<unknown>([{ hidden: r() < 0.5 }, { faction: pick([null, "banda", "altri"]) }, { conditions: [] }]) },
          { type: "scene.activate", sceneId: pick([MAIN, OTHER, null]) },
          { type: "scene.delete", sceneId: pick([OTHER, "x"]) },
          { type: "token.move", tokenId: anyTk(), x: r() * 1400, y: r() * 1000 },
          null,
          { type: "combat.next" },
          { type: "group.apply", target: {}, action: {} },
        ]);
    }
  }
  return { command, pick, int };
}

const ACTORS: Actor[] = [GM, P1, P2, STRANGER];

function viewSorted(v: CampaignView): CampaignView {
  return {
    ...v,
    tokens: [...v.tokens].sort((a, b) => a.id.localeCompare(b.id)),
    combats: [...(v.combats ?? [])].sort((a, b) => a.sceneId.localeCompare(b.sceneId)),
    groups: v.groups ? [...v.groups].sort((a, b) => a.id.localeCompare(b.id)) : v.groups,
  };
}

describe("fuzz del combattimento", () => {
  for (const seed of SEEDS) {
    it(`seme ${seed}`, () => {
      const r = rng(seed);
      const g = generator(r);
      let state = deepFreeze(initial());
      let history: History = createHistory(60);
      const views = new Map<string, CampaignView>([GM, P1, P2].map((a) => [a.userId, viewFor(state, a)]));
      let applied = 0;
      let startedSeen = 0;
      let noticeSeen = 0;
      let groupApplied = 0;

      for (let step = 0; step < STEPS; step++) {
        const actor = r() < 0.55 ? GM : g.pick(ACTORS);
        const roll = r();
        let cmd: unknown = null;
        let res: HistoryResult;
        if (roll < 0.1) res = undo(state, history, actor);
        else if (roll < 0.16) res = redo(state, history, actor);
        else {
          cmd = g.command();
          res = execute(state, history, cmd, actor);
        }
        const ctx = () => `seme ${seed} passo ${step} ${actor.userId} ${JSON.stringify(cmd)}`;
        if (!res.ok) {
          if (actor.role === "player") {
            const json = JSON.stringify(res);
            for (const s of SECRET_NAMES) expect(json, ctx()).not.toContain(s);
          }
          continue;
        }
        const prev = state;
        expect(res.state.version, ctx()).toBe(res.changes.length > 0 ? prev.version + 1 : prev.version);
        if (res.changes.length === 0) continue;
        applied++;
        if ((cmd as { type?: string } | null)?.type === "group.apply") groupApplied++;
        state = deepFreeze(res.state);
        history = res.history;
        expect(checkInvariants(state), ctx()).toEqual([]);

        // Round e turni coerenti.
        for (const c of state.combats ?? []) {
          if (c.started) {
            startedSeen++;
            expect(c.round, ctx()).toBeGreaterThanOrEqual(1);
            expect(c.participants.some((p) => p.id === c.turnId), ctx()).toBe(true);
            expect(c.step, ctx()).toBeLessThanOrEqual(c.maxStep);
          }
        }
        // I round non diminuiscono con `next` (solo `previous`, annulla o rimozioni possono riportare indietro).
        if ((cmd as { type?: string } | null)?.type === "combat.next") {
          const a = combatOf(prev, (cmd as { sceneId: string }).sceneId);
          const b = combatOf(state, (cmd as { sceneId: string }).sceneId);
          if (a && b && a.started && b.started) expect(b.round, ctx()).toBeGreaterThanOrEqual(a.round);
        }
        // Gli effetti non salgono mai di durata scorrendo i turni.
        if ((cmd as { type?: string } | null)?.type === "combat.next") {
          for (const t of state.tokens) {
            const old = prev.tokens.find((x) => x.id === t.id);
            for (const e of t.effects ?? []) {
              const oe = old?.effects?.find((x) => x.id === e.id);
              if (oe && oe.remaining !== null && e.remaining !== null) expect(e.remaining, ctx()).toBeLessThanOrEqual(oe.remaining);
            }
          }
        }

        for (const viewer of [GM, P1, P2]) {
          const events = filterEventsFor(res.changes, viewer);
          if (viewer.role === "player") {
            noticeSeen += events.filter((e) => e.type.startsWith("effect.") || e.type === "combat.turn").length;
            const json = JSON.stringify(events) + JSON.stringify(viewFor(state, viewer));
            expect(json, ctx()).not.toContain('"faction"');
            expect(json, ctx()).not.toContain('"groups"');
            // I token nascosti non compaiono mai (né nei partecipanti): il loro nome segreto non trapela.
            for (const t of state.tokens) {
              if (t.hidden && t.ownerUserId !== viewer.userId) expect(json, ctx()).not.toContain(t.name);
            }
            // I segreti non arrivano.
            for (const t of state.tokens) for (const e of t.effects ?? []) if (e.secret) expect(JSON.stringify(viewFor(state, viewer)), ctx()).not.toContain(`"id":"${e.id}","name":"${e.name}","condition":${JSON.stringify(e.condition)},"remaining":${e.remaining},"timing":"${e.timing}","secret"`);
            for (const c of viewFor(state, viewer).combats ?? []) {
              for (const p of c.participants) {
                expect("hidden" in p, ctx()).toBe(false);
                const real = state.combats?.find((x) => x.sceneId === c.sceneId)?.participants.find((x) => x.id === p.id);
                expect(real?.hidden, ctx()).toBe(false);
                if (real?.hideInitiative) expect(p.initiative, ctx()).toBeNull();
              }
            }
          }
          const rebuilt = { ...events.reduce(applyServerEvent, views.get(viewer.userId)!), version: state.version };
          expect(viewSorted(rebuilt), `${ctx()} delta per ${viewer.userId}`).toEqual(viewSorted(viewFor(state, viewer)));
          views.set(viewer.userId, rebuilt);
        }
      }
      expect(applied).toBeGreaterThan(60);
      expect(startedSeen + noticeSeen + groupApplied).toBeGreaterThan(0);
    });
  }

  it("il fuzz esercita davvero turni, avvisi e azioni di gruppo (somma sui semi)", () => {
    let started = 0;
    let groups = 0;
    for (const seed of SEEDS.slice(0, 3)) {
      const r = rng(seed);
      const g = generator(r);
      let state = deepFreeze(initial());
      let history: History = createHistory(60);
      for (let i = 0; i < STEPS; i++) {
        const cmd = g.command();
        const res = execute(state, history, cmd, GM);
        if (!res.ok || res.changes.length === 0) continue;
        state = res.state;
        history = res.history;
        if ((cmd as { type?: string } | null)?.type === "group.apply") groups++;
        if ((state.combats ?? []).some((c) => c.started)) started++;
      }
    }
    expect(started).toBeGreaterThan(20);
    expect(groups).toBeGreaterThan(3);
  });
});
