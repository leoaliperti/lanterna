import { describe, expect, it } from "vitest";
import { applyServerEvent } from "../protocol/client.js";
import type { Command } from "./commands.js";
import { filterEventsFor } from "./filter.js";
import { GM, P1, P2, STRANGER, deepFreeze, rng, scene, token } from "./fixtures.test-utils.js";
import { createHistory, execute, redo, undo, type History, type HistoryResult } from "./history.js";
import { checkInvariants } from "./invariants.js";
import { CampaignStateSchema, type Actor, type CampaignState } from "./schema.js";
import { canSeeToken, viewFor, type CampaignView } from "./view.js";

/**
 * Fuzz/property-based: sequenze casuali (ma riproducibili) di comandi validi,
 * quasi validi e spazzatura, da attori casuali, con annulla/ripeti intercalati.
 * Proprietà verificate a ogni passo:
 * 1. nessuna eccezione;
 * 2. invarianti dello stato rispettati e input mai mutato;
 * 3. versione: +1 se cambia qualcosa, invariata altrimenti;
 * 4. nessuna fuga verso i giocatori (viewFor, eventi, errori);
 * 5. applicare i delta filtrati alla vista precedente dà esattamente viewFor.
 */

const SEEDS = [1, 2, 3, 42, 1337, 2024, 9001, 31337];
const STEPS = 800;
const ACTORS: Actor[] = [GM, P1, P2, STRANGER];
const PLAYERS: Actor[] = [P1, P2];

const tid = (n: number) => `tk-${n}-z`;
const sid = (n: number) => `sc-${n}-z`;

function initial(): CampaignState {
  return CampaignStateSchema.parse({
    campaignId: "camp-fuzz",
    name: "Fuzz",
    version: 0,
    activeSceneId: sid(0),
    members: [
      { userId: "gm1", displayName: "Master", role: "admin" },
      { userId: "p1", displayName: "Alice", role: "player" },
      { userId: "p2", displayName: "Bruno", role: "player" },
    ],
    scenes: [scene(sid(0), { name: `Nome-${sid(0)}` }), scene(sid(1), { name: `Nome-${sid(1)}` })],
    tokens: [],
  });
}

function gen(r: () => number) {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const int = (n: number) => Math.floor(r() * n);
  const weird = () =>
    pick<unknown>([Number.NaN, Number.POSITIVE_INFINITY, -1, 1e9, "12", null, undefined, {}, [], -0, 0.5, 2 ** 53]);
  const coord = () => (r() < 0.1 ? (weird() as number) : r() < 0.1 ? -50 + r() * 1600 : r() * 1400);
  const owner = () => pick([null, "p1", "p2", "gm1", r() < 0.05 ? "ghost" : null]);
  const anyTid = () => tid(int(25));
  const anySid = () => sid(int(4));

  function command(): unknown {
    switch (int(12)) {
      case 0:
      case 1:
      case 2:
        return { type: "token.move", tokenId: anyTid(), x: coord(), y: coord(), ...(r() < 0.3 ? { snap: r() < 0.5 } : {}) };
      case 3: {
        const id = int(25);
        return {
          type: "token.create",
          token: token(tid(id), {
            sceneId: anySid(),
            name: `Nome-${tid(id)}`,
            gmNotes: `Nota-${tid(id)}`,
            hidden: r() < 0.4,
            ownerUserId: owner(),
            x: coord(),
            y: coord(),
            size: pick([0.5, 1, 2, 3]),
            kind: pick(["pc", "monster", "object"] as const),
            health: r() < 0.8 ? { current: 7, max: 50 + int(5000), temp: int(5) } : null,
          }),
        };
      }
      case 4: {
        const patches: unknown[] = [
          { hidden: r() < 0.5 },
          { ownerUserId: owner() },
          { conditions: r() < 0.5 ? [] : [{ id: "prone", name: "Prono" }] },
          { rotation: r() * 1000 - 500 },
          { size: pick([0.25, 1, 2, 40, 0]) },
          { health: { current: 1, max: 2, temp: 0 } },
          { gmNotes: "nota" },
          { name: "Rinominato" },
          { kind: "object" },
          { hidden: false, conditions: [] },
          { x: 3 },
          {},
        ];
        return { type: "token.update", tokenId: anyTid(), patch: pick(patches) };
      }
      case 5:
        return { type: "token.delete", tokenId: anyTid() };
      case 6:
        return { type: "scene.activate", sceneId: r() < 0.15 ? null : anySid() };
      case 7: {
        const id = int(4);
        return { type: "scene.create", scene: scene(sid(id), { name: `Nome-${sid(id)}`, width: 200 + int(1500) }) };
      }
      case 8:
        return { type: "scene.update", sceneId: anySid(), patch: pick<unknown>([{ width: 100 + int(1500) }, { height: 50 + int(1000) }, { name: "S" }, { width: 0 }]) };
      case 9:
        return { type: "scene.setGrid", sceneId: anySid(), grid: pick<unknown>([{ cellSize: 20 + int(100) }, { snap: r() < 0.5 }, { offsetX: 5 }, { opacity: 3 }]) };
      case 10:
        return r() < 0.3 ? { type: "scene.delete", sceneId: anySid() } : { type: "token.move", tokenId: anyTid(), x: weird(), y: coord() };
      default:
        return pick<unknown>([null, 42, "x", {}, { type: "token.move" }, { type: "token.move", tokenId: anyTid(), x: 1, y: 1, evil: 1 }, { type: "__proto__" }]);
    }
  }
  return { pick, int, command };
}

const sortTokens = (v: CampaignView): CampaignView => ({
  ...v,
  tokens: [...v.tokens].sort((a, b) => a.id.localeCompare(b.id)),
});

/** Stringhe che `viewer` non deve mai vedere nello stato `s`. */
function forbiddenFor(s: CampaignState, viewer: Actor): string[] {
  const out: string[] = [];
  for (const t of s.tokens) {
    out.push(`Nota-${t.id}`);
    if (!canSeeToken(t, viewer, s.activeSceneId)) out.push(t.id, `Nome-${t.id}`);
  }
  for (const sc of s.scenes) if (sc.id !== s.activeSceneId) out.push(sc.id, `Nome-${sc.id}`);
  return out;
}

function assertNoLeak(json: string, forbidden: string[], where: string) {
  for (const f of forbidden) if (json.includes(f)) throw new Error(`${where}: trapela "${f}"`);
}

/** Vita visibile solo al proprietario. */
function assertHealthOk(v: CampaignView, viewer: Actor) {
  for (const t of v.tokens) {
    if (t.health !== null && t.ownerUserId !== viewer.userId) throw new Error(`vita di ${t.id} visibile a ${viewer.userId}`);
    if ("gmNotes" in t) throw new Error("gmNotes al giocatore");
  }
}

describe("fuzz del riduttore con filtro e annulla/ripeti", () => {
  for (const seed of SEEDS) {
    it(`seme ${seed}`, () => {
      const r = rng(seed);
      const g = gen(r);
      let state = deepFreeze(initial());
      let history: History = createHistory(50);
      const views = new Map<string, CampaignView>(ACTORS.slice(0, 3).map((a) => [a.userId, viewFor(state, a)]));
      let applied = 0;

      for (let step = 0; step < STEPS; step++) {
        const actor = r() < 0.4 ? GM : g.pick(ACTORS);
        const roll = r();
        let cmd: unknown = null;
        let res: HistoryResult;
        if (roll < 0.1) res = undo(state, history, actor);
        else if (roll < 0.15) res = redo(state, history, actor);
        else {
          cmd = g.command();
          res = execute(state, history, cmd, actor);
        }
        const ctx = () => `seme ${seed} passo ${step} attore ${actor.userId} cmd ${JSON.stringify(cmd)}`;

        if (!res.ok) {
          // Gli errori verso un giocatore non contengono dati invisibili.
          if (actor.role === "player") assertNoLeak(JSON.stringify(res), forbiddenFor(state, actor), ctx());
          continue;
        }
        const prev = state;
        expect(res.state.version, ctx()).toBe(res.changes.length > 0 ? prev.version + 1 : prev.version);
        if (res.changes.length === 0) continue;
        applied++;
        state = deepFreeze(res.state);
        history = res.history;
        expect(checkInvariants(state), ctx()).toEqual([]);
        // Lo straniero non membro non deve poter cambiare nulla tramite comandi (non è nei membri,
        // ma il server deve rifiutarlo prima: qui controlliamo solo che non possa fare azioni da GM).
        if (actor === STRANGER) expect((cmd as Command | null)?.type, ctx()).toBe("token.move");

        for (const viewer of [GM, ...PLAYERS]) {
          const events = filterEventsFor(res.changes, viewer);
          const expected = viewFor(state, viewer);
          if (viewer.role === "player") {
            const forbidden = forbiddenFor(state, viewer);
            const prevForbidden = forbiddenFor(prev, viewer);
            // Gli eventi non devono contenere nulla che sia invisibile sia prima sia dopo.
            assertNoLeak(JSON.stringify(events), forbidden.filter((f) => prevForbidden.includes(f)), `${ctx()} eventi`);
            assertNoLeak(JSON.stringify(expected), forbidden, `${ctx()} viewFor`);
            assertHealthOk(expected, viewer);
          }
          const rebuilt = { ...events.reduce(applyServerEvent, views.get(viewer.userId)!), version: state.version };
          expect(sortTokens(rebuilt), `${ctx()} delta per ${viewer.userId}`).toEqual(sortTokens(expected));
          views.set(viewer.userId, rebuilt);
        }
      }
      // Il fuzz deve effettivamente esercitare il riduttore.
      expect(applied).toBeGreaterThan(100);
    });
  }
});
