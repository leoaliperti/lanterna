import { describe, expect, it } from "vitest";
import { applyServerEvent } from "../protocol/client.js";
import { filterEventFor } from "./filter.js";
import { GM, P1, baseState, deepFreeze } from "./fixtures.test-utils.js";
import { createHistory, execute, undo } from "./history.js";
import { applyCommand } from "./reducer.js";
import { DEFAULT_CLOCK, type CampaignState } from "./schema.js";
import { viewFor } from "./view.js";

const world = (): CampaignState => deepFreeze(baseState());

describe("orologio di gioco", () => {
  it("di default è giorno 1, ore 8:00", () => {
    expect(DEFAULT_CLOCK).toEqual({ day: 1, minute: 480 });
  });

  it("solo il GM lo imposta; il giocatore riceve FORBIDDEN e nulla cambia", () => {
    const r = applyCommand(world(), { type: "clock.set", day: 2 }, P1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("FORBIDDEN");
  });

  it("il GM imposta giorno e/o minuto; l'assente resta com'era", () => {
    const r1 = applyCommand(world(), { type: "clock.set", day: 3 }, GM);
    expect(r1.ok && r1.state.clock).toEqual({ day: 3, minute: 480 });
    const r2 = applyCommand(world(), { type: "clock.set", minute: 1230 }, GM);
    expect(r2.ok && r2.state.clock).toEqual({ day: 1, minute: 1230 });
  });

  it("valori fuori limite non passano la validazione (minuto 1440, giorno 0)", () => {
    const bad = applyCommand(world(), { type: "clock.set", minute: 1440 } as never, GM);
    expect(bad.ok).toBe(false);
  });

  it("annulla riporta l'orologio al valore di prima", () => {
    const h = createHistory();
    const r = execute(world(), h, { type: "clock.set", day: 5, minute: 60 }, GM);
    if (!r.ok) throw new Error("comando rifiutato");
    expect(r.state.clock).toEqual({ day: 5, minute: 60 });
    const u = undo(r.state, r.history, GM);
    if (!u.ok) throw new Error("annullamento rifiutato: " + JSON.stringify(u.error));
    expect(u.state.clock ?? DEFAULT_CLOCK).toEqual(DEFAULT_CLOCK);
  });

  it("è pubblico: ogni giocatore lo vede nella vista e riceve il delta", () => {
    const r = applyCommand(world(), { type: "clock.set", day: 4, minute: 720 }, GM);
    if (!r.ok) throw new Error("comando rifiutato");
    expect(viewFor(r.state, P1).clock).toEqual({ day: 4, minute: 720 });
    const change = r.changes[0]!;
    const events = filterEventFor(change, P1);
    expect(events).toEqual([{ type: "clock.changed", clock: { day: 4, minute: 720 } }]);
    const base = viewFor(world(), P1);
    expect(applyServerEvent(base, events[0]!).clock).toEqual({ day: 4, minute: 720 });
  });

  it("lo stato senza orologio resta valido e la vista non lo mostra", () => {
    expect(viewFor(world(), P1).clock).toBeUndefined();
  });
});
