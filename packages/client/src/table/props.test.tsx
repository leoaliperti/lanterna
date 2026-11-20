import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropView, SceneView } from "@lanterna/shared";
import { DEFAULT_GRID, DEFAULT_SCALE } from "@lanterna/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fadeFactorStep, pointInProp, propFadeTargets } from "../map/propLogic";
import type { MapProp, MapToken } from "../map";
import { toMapProps } from "./adapter";
import { CampaignChoiceContext, CampaignSwitcher } from "./CampaignSwitcher";
import { draftOfProp, newProp, updateCommand } from "./propDraft";

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
});
afterEach(() => cleanup());

const scene: SceneView = { id: "s1", name: "S", map: null, width: 1400, height: 1000, grid: { ...DEFAULT_GRID }, scale: { ...DEFAULT_SCALE } };

const prop = (over: Partial<MapProp> = {}): MapProp => ({ id: "p", url: "/a.png", x: 300, y: 300, width: 140, height: 140, rotation: 0, layer: "above", opacity: 1, fade: true, ...over });
const tok = (id: string, x: number, y: number, kind: MapToken["kind"] = "character"): MapToken => ({ id, x, y, size: 1, rotation: 0, kind });

describe("livelli: dissolvenza degli oggetti sopra i token", () => {
  it("pointInProp rispetta la rotazione", () => {
    const wide = { x: 0, y: 0, width: 200, height: 20, rotation: 90 };
    expect(pointInProp(wide, 0, 90)).toBe(true);
    expect(pointInProp(wide, 90, 0)).toBe(false);
  });

  it("il giocatore schiarisce solo sotto i propri token", () => {
    const tokens = [tok("mine", 300, 300), tok("other", 1000, 900)];
    const base = { tokens, role: "player" as const, movableTokenIds: ["mine"] };
    expect([...propFadeTargets([prop()], base)]).toEqual(["p"]);
    expect(propFadeTargets([prop({ x: 1000, y: 900 })], base).size).toBe(0);
    expect(propFadeTargets([prop({ fade: false })], base).size).toBe(0);
    expect(propFadeTargets([prop({ layer: "ground" })], base).size).toBe(0);
  });

  it("il GM schiarisce sotto i personaggi, non sotto i mostri", () => {
    const gm = { role: "gm" as const, movableTokenIds: [] };
    expect(propFadeTargets([prop()], { ...gm, tokens: [tok("pg", 300, 300)] }).size).toBe(1);
    expect(propFadeTargets([prop()], { ...gm, tokens: [tok("m", 300, 300, "monster")] }).size).toBe(0);
  });

  it("la dissolvenza avanza senza oltrepassare l'obiettivo", () => {
    expect(fadeFactorStep(0, 1, 90)).toBeCloseTo(0.5);
    expect(fadeFactorStep(0.9, 1, 500)).toBe(1);
    expect(fadeFactorStep(0.1, 0, 500)).toBe(0);
  });
});

describe("oggetti di scena: adattatore e modulo", () => {
  const view = (over: Partial<PropView> = {}): PropView => ({
    id: "p", sceneId: "s1", imageUrl: "/assets/x.png", x: 300, y: 300, width: 140, height: 140, rotation: 0, layer: "above", opacity: 1, fade: true, name: "Quercia", hidden: false, ...over
  });

  it("toMapProps filtra per scena e porta il nascosto solo se il server l'ha inviato", () => {
    const shown = toMapProps([view(), view({ id: "q", sceneId: "other" }), view({ id: "h", hidden: true })], "s1");
    expect(shown.map((p) => p.id)).toEqual(["p", "h"]);
    expect(shown[0]?.hidden).toBeUndefined();
    expect(shown[1]?.hidden).toBe(true);
    expect(toMapProps([{ ...view(), name: undefined, hidden: undefined }], "s1")[0]?.hidden).toBeUndefined();
  });

  it("newProp sta al centro, in scala e con dissolvenza solo sopra", () => {
    const p = newProp({ id: "n", name: " Albero ", url: "/a.png", imageWidth: 1000, imageHeight: 500, layer: "above" }, scene);
    expect(p).toMatchObject({ x: 700, y: 500, width: 210, height: 105, fade: true, name: "Albero" });
    expect(newProp({ id: "n", name: "", url: "/a.png", imageWidth: 10, imageHeight: 10, layer: "ground" }, scene)).toMatchObject({ width: 10, fade: false, name: "Oggetto" });
  });

  it("updateCommand invia solo i campi cambiati e rifiuta valori non validi", () => {
    const v = view();
    const d = draftOfProp(v);
    expect(updateCommand(v, d, scene)).toBeNull();
    expect(updateCommand(v, { ...d, layer: "ground", x: "400", rotation: "-90" }, scene)).toEqual({
      type: "prop.update",
      propId: "p",
      patch: { layer: "ground", x: 400, rotation: 270 }
    });
    expect(updateCommand(v, { ...d, width: "0" }, scene)).toBeNull();
    expect(updateCommand(v, { ...d, x: "abc" }, scene)).toBeNull();
    expect(updateCommand(v, { ...d, x: "99999" }, scene)).toBeNull();
  });
});

describe("selettore di campagne", () => {
  const campaigns = [
    { id: "c1", name: "Prima", createdAt: "" },
    { id: "c2", name: "Seconda", createdAt: "" }
  ];

  it("senza scelta il titolo e' un titolo semplice", () => {
    render(
      <CampaignChoiceContext.Provider value={{ campaigns: [campaigns[0]!], currentId: "c1", onSelect: () => undefined }}>
        <CampaignSwitcher title="Prima" />
      </CampaignChoiceContext.Provider>
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("heading", { name: "Prima" })).toBeTruthy();
  });

  it("con piu' campagne il menu cambia campagna; solo l'admin vede 'Nuova campagna'", async () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <CampaignChoiceContext.Provider value={{ campaigns, currentId: "c1", onSelect }}>
        <CampaignSwitcher title="Prima" />
      </CampaignChoiceContext.Provider>
    );
    await userEvent.click(screen.getByRole("button", { name: /Cambia campagna/ }));
    expect(screen.queryByText("Nuova campagna")).toBeNull();
    await userEvent.click(screen.getByText("Seconda"));
    expect(onSelect).toHaveBeenCalledWith("c2");

    rerender(
      <CampaignChoiceContext.Provider value={{ campaigns, currentId: "c1", onSelect, onCreate: async () => undefined }}>
        <CampaignSwitcher title="Prima" />
      </CampaignChoiceContext.Provider>
    );
    await userEvent.click(screen.getByRole("button", { name: /Cambia campagna/ }));
    expect(screen.getByText("Nuova campagna")).toBeTruthy();
  });
});
