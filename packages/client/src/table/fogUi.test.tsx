import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, viewFor, type Actor, type CampaignState } from "@lanterna/shared";
import type { SessionUser } from "../api/client";
import { FakeSocket } from "../realtime/fakeSocket";
import { RealtimeClient } from "../realtime/RealtimeClient";
import { RealtimeProvider } from "../realtime/RealtimeProvider";
import { SessionProvider } from "../session/SessionProvider";
import { ToastProvider } from "../ui";
import { toMapFog, toMapScene, toMapWalls } from "./adapter";
import { toggleTarget, validTargets } from "./fogControls";
import { Table } from "./Table";
import { createCommand, diffDraft, draftOfToken, emptyDraft, validateDraft, visionOfDraft } from "./tokenDraft";
import { gm, luca, state as base, token } from "./testState";

/** Scena con nebbia: Luca vede la stanza in alto a sinistra (tessera 0,0), Sara niente. */
const fogged: CampaignState = {
  ...base,
  fogs: [
    {
      sceneId: "s1",
      cellSize: 70,
      offsetX: 0,
      offsetY: 0,
      lighting: "bright",
      everyone: { base: "covered", runs: [] },
      players: [{ userId: "luca", mask: { base: "covered", runs: [0, 0, 4, 1, 0, 4] } }]
    }
  ],
  walls: [
    { id: "w1", sceneId: "s1", x1: 0, y1: 140, x2: 280, y2: 140, door: false, open: false },
    { id: "w-lontano", sceneId: "s1", x1: 1000, y1: 700, x2: 1000, y2: 900, door: true, open: false }
  ],
  tokens: [...base.tokens, token({ id: "visto", sceneId: "s1", x: 105, y: 105, vision: { range: 30, darkvision: 0, bright: 0, dim: 0 } })]
};

describe("adattatore della nebbia", () => {
  it("giocatore: velo opaco con la SUA maschera, mappa a tessere e solo quelle con celle rivelate", () => {
    const view = viewFor(fogged, luca);
    const scene = view.scenes[0]!;
    const fog = toMapFog(view, scene, { viewAs: null, showVeil: true })!;
    expect(fog.opaque).toBe(true);
    expect(fog.mask).toEqual({ base: "covered", runs: [0, 0, 4, 1, 0, 4] });
    expect(fog.tiles.map((t) => t.id)).toEqual(["0,0"]);
    expect(fog.tiles[0]!.url).toMatch(/^\/api\/campaigns\/c1\/scenes\/s1\/tiles\/0\/0\?k=/);
    expect(toMapScene(view, scene, { fog }).background.url).not.toContain("/assets/"); // `map: null` -> sfondo vuoto
  });

  it("giocatore senza celle rivelate: nessuna tessera da chiedere", () => {
    const view = viewFor(fogged, { userId: "sara", role: "player" });
    const fog = toMapFog(view, view.scenes[0]!, { viewAs: null, showVeil: true })!;
    expect(fog.tiles).toEqual([]);
    expect(fog.mask).toEqual({ base: "covered", runs: [] });
  });

  it("GM: velo in trasparenza, mappa intera senza tessere; 'vista come' sceglie la maschera", () => {
    const view = viewFor(fogged, gm);
    const scene = view.scenes[0]!;
    const all = toMapFog(view, scene, { viewAs: null, showVeil: true })!;
    expect(all.opaque).toBe(false);
    expect(all.tiles).toEqual([]);
    expect(all.mask).toEqual({ base: "covered", runs: [] });
    expect(toMapFog(view, scene, { viewAs: "luca", showVeil: true })!.mask).toEqual({ base: "covered", runs: [0, 0, 4, 1, 0, 4] });
    expect(toMapFog(view, scene, { viewAs: "sara", showVeil: true })!.mask).toEqual({ base: "covered", runs: [] }); // senza maschera propria = tutti
    expect(toMapFog(view, scene, { viewAs: null, showVeil: false })!.mask).toBeNull();
    expect(toMapScene(view, scene, {}).background.url).toBe("/api/assets/aaaa.png");
  });

  it("scena senza nebbia: nessun velo", () => {
    const view = viewFor(base, luca);
    expect(toMapFog(view, view.scenes[0]!, { viewAs: null, showVeil: true })).toBeNull();
  });

  it("muri: il giocatore riceve solo i pezzi nelle celle rivelate", () => {
    const g = toMapWalls(viewFor(fogged, gm).walls, "s1");
    expect(g.map((w) => w.id)).toEqual(["w1", "w-lontano"]);
    const p = toMapWalls(viewFor(fogged, luca).walls, "s1");
    expect(p.map((w) => w.id)).toEqual(["w1"]); // il muro lontano e' sotto la nebbia
    expect(JSON.stringify(p)).not.toContain("1000");
  });

  it("la vista (`vision`) arriva solo al proprietario e al GM", () => {
    const owned: CampaignState = { ...fogged, tokens: fogged.tokens.map((t) => (t.id === "visto" ? { ...t, ownerUserId: "luca" } : t)) };
    expect(viewFor(owned, luca).tokens.find((t) => t.id === "visto")!.vision).toBeTruthy();
    expect(viewFor(owned, { userId: "sara", role: "player" }).tokens.find((t) => t.id === "visto")?.vision ?? null).toBeNull();
    expect(viewFor(owned, gm).tokens.find((t) => t.id === "visto")!.vision).toBeTruthy();
  });
});

describe("destinatari", () => {
  it("scelta a chip: aggiunge, toglie, ordine dei giocatori; chi se ne va sparisce", () => {
    const ids = ["a", "b", "c"];
    expect(toggleTarget([], "b", ids)).toEqual(["b"]);
    expect(toggleTarget(["b"], "a", ids)).toEqual(["a", "b"]);
    expect(toggleTarget(["a", "b"], "a", ids)).toEqual(["b"]);
    expect(validTargets(["a", "x"], ids)).toEqual(["a"]);
  });
});

describe("vista del token nell'editor", () => {
  const view = viewFor(fogged, gm);
  const t = view.tokens.find((x) => x.id === "visto")!;
  it("bozza <-> vista: raggio vuoto = illimitato; valori non validi = errore", () => {
    const d = draftOfToken(t);
    expect(d.hasVision).toBe(true);
    expect(visionOfDraft(d)).toEqual({ range: 30, darkvision: 0, bright: 0, dim: 0 });
    expect(visionOfDraft({ ...d, visionRange: "" })).toEqual({ range: null, darkvision: 0, bright: 0, dim: 0 });
    expect(visionOfDraft({ ...d, hasVision: false })).toBeNull();
    expect(validateDraft({ ...d, lightBright: "-3" }).vision).toMatch(/Raggio e luci/);
    expect(validateDraft({ ...d, visionRange: "abc" }).vision).toBeTruthy();
    expect(validateDraft(d).vision).toBeNull();
  });
  it("diff: solo se la vista e' cambiata; si puo' spegnere e creare con una vista", () => {
    const d = draftOfToken(t);
    expect(diffDraft(t, d, t.imageUrl, false).vision).toBeUndefined();
    expect(diffDraft(t, { ...d, darkvision: "60" }, t.imageUrl, false).vision).toEqual({ range: 30, darkvision: 60, bright: 0, dim: 0 });
    expect(diffDraft(t, { ...d, hasVision: false }, t.imageUrl, false).vision).toBeNull();
    const plain = view.tokens.find((x) => x.id === "pg-sara")!;
    expect(diffDraft(plain, draftOfToken(plain), plain.imageUrl, false).vision).toBeUndefined();
    const created = createCommand("id1", "s1", { ...emptyDraft(), name: "Torcia", hasVision: true, visionRange: "", lightBright: "20", lightDim: "20" }, null, 0, 0);
    expect(created).toMatchObject({ token: { vision: { range: null, darkvision: 0, bright: 20, dim: 20 } } });
  });
});

/* ---------------- tavolo (jsdom: senza WebGL il canvas non c'e', ma la barra e il pannello si') ---------------- */

let sockets: FakeSocket[] = [];
const cur = () => sockets[sockets.length - 1]!;
const users: Record<string, SessionUser> = {
  gm: { id: "gm", name: "Marta", email: "m@example.org", role: "admin" },
  luca: { id: "luca", name: "Luca", email: "l@example.org", role: "player" }
};

function mount(actor: Actor, state: CampaignState) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ user: users[actor.userId] }), { status: 200 })));
  const client = new RealtimeClient({
    campaignId: "c1",
    url: "ws://test/api/ws",
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    isOnline: () => true,
    commandTimeoutMs: 60_000
  });
  render(
    <ToastProvider>
      <SessionProvider>
        <RealtimeProvider campaignId="c1" client={client}>
          <Table user={users[actor.userId]!} campaignName="Campagna" />
        </RealtimeProvider>
      </SessionProvider>
    </ToastProvider>
  );
  act(() => {
    cur().open();
    cur().push({ type: "snapshot", protocolVersion: PROTOCOL_VERSION, epoch: "e1", version: state.version, view: viewFor(state, actor) });
  });
}

beforeEach(() => {
  sockets = [];
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined
  }));
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Risponde con un ack all'ultimo comando inviato (il pannello aspetta l'esito prima di riabilitare i pulsanti). */
const ackLast = async () => {
  const last = cur().sent.filter((m) => m.type === "command").at(-1) as { requestId: string };
  await act(async () => cur().push({ type: "ack", requestId: last.requestId, version: 99 }));
};
const sentCommands = () => cur().sent.filter((m) => m.type === "command").map((m) => (m as { command: Record<string, unknown> }).command);

describe("interfaccia della nebbia nel tavolo", () => {
  it("GM, scena senza nebbia: la scheda Nebbia attiva la nebbia con lo stato iniziale scelto", async () => {
    const u = userEvent.setup();
    mount(gm, base);
    await u.click(await screen.findByRole("tab", { name: "Nebbia" }));
    const panel = within(screen.getByRole("complementary", { name: "Pannello laterale" }));
    await u.click(panel.getByRole("radio", { name: "Tutto scoperto" }));
    await u.click(panel.getByRole("button", { name: "Attiva la nebbia" }));
    expect(sentCommands().at(-1)).toEqual({ type: "fog.enable", sceneId: "s1", initial: "revealed" });
  });

  it("GM, nebbia attiva: rivela tutto per i giocatori scelti; copri tutto chiede conferma; luce e disattiva", async () => {
    const u = userEvent.setup();
    mount(gm, fogged);
    await u.click(await screen.findByRole("tab", { name: "Nebbia" }));
    const panel = within(screen.getByRole("complementary", { name: "Pannello laterale" }));
    // Chip dei destinatari: Tutti selezionato all'inizio.
    expect(panel.getByRole("button", { name: "Tutti" }).getAttribute("aria-pressed")).toBe("true");
    await u.click(panel.getByRole("button", { name: "Luca" }));
    expect(panel.getByRole("button", { name: "Tutti" }).getAttribute("aria-pressed")).toBe("false");
    await u.click(panel.getByRole("button", { name: "Rivela tutto" }));
    expect(sentCommands().at(-1)).toEqual({ type: "fog.revealAll", sceneId: "s1", target: { kind: "players", userIds: ["luca"] } });
    await ackLast();

    await u.click(panel.getByRole("button", { name: "Copri tutto" }));
    expect(sentCommands().at(-1)?.type).toBe("fog.revealAll"); // niente senza conferma
    const alert = await screen.findByRole("alertdialog", { name: "Coprire tutta la mappa?" });
    await u.click(within(alert).getByRole("button", { name: "Copri tutto" }));
    expect(sentCommands().at(-1)).toEqual({ type: "fog.coverAll", sceneId: "s1", target: { kind: "players", userIds: ["luca"] } });
    await ackLast();

    await u.click(panel.getByRole("radio", { name: "Buio" }));
    expect(sentCommands().at(-1)).toEqual({ type: "fog.setLighting", sceneId: "s1", lighting: "dark" });
  });

  it("GM: la barra offre selezione, pennelli, modo rivela/copri, muri e vista dei token", async () => {
    mount(gm, fogged);
    const bar = await screen.findByRole("toolbar", { name: "Strumenti della nebbia e dei muri" });
    const names = within(bar).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(
      expect.arrayContaining(["Seleziona (V)", "Muri e porte (W)", "Mostra la vista dei token (solo aiuto visivo)"])
    );
    for (const brush of ["Rettangolo", "Cerchio", "Poligono", "Celle"]) expect(names.some((n) => n?.startsWith(brush))).toBe(true);
    expect(within(bar).getByRole("radio", { name: "Rivela" })).toBeTruthy();
    expect(within(bar).getByRole("radio", { name: "Copri" })).toBeTruthy();
  });

  it("GM senza nebbia: la barra non offre i pennelli, solo muri e vista", async () => {
    mount(gm, base);
    const bar = await screen.findByRole("toolbar", { name: "Strumenti della nebbia e dei muri" });
    expect(within(bar).queryByRole("radio", { name: "Rivela" })).toBeNull();
    expect(within(bar).getByRole("button", { name: "Muri e porte (W)" })).toBeTruthy();
  });

  it("giocatore: nessuna scheda Nebbia e nessuno strumento GM; il controllo di vista solo se ha un token con vista", async () => {
    mount(luca, fogged);
    await screen.findByRole("button", { name: /^Annulla/ });
    expect(screen.queryByRole("tab", { name: "Nebbia" })).toBeNull();
    expect(screen.queryByRole("toolbar", { name: "Strumenti della nebbia e dei muri" })).toBeNull();
    expect(screen.queryByRole("toolbar", { name: "Vista del tuo token" })).toBeNull(); // non possiede token con vista
    cleanup();
    sockets = [];
    const owned: CampaignState = { ...fogged, tokens: fogged.tokens.map((t) => (t.id === "visto" ? { ...t, ownerUserId: "luca" } : t)) };
    mount(luca, owned);
    const bar = await screen.findByRole("toolbar", { name: "Vista del tuo token" });
    const u = userEvent.setup();
    const toggle = within(bar).getByRole("button", { name: /vista dei token/i });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await u.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });
});
