import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, viewFor, type Actor, type LibraryItem, type LibraryItemPublic } from "@lanterna/shared";
import { FakeSocket } from "../realtime/fakeSocket";
import { RealtimeClient } from "../realtime/RealtimeClient";
import { RealtimeProvider } from "../realtime/RealtimeProvider";
import { gm, luca, state } from "../table/testState";
import { ToastProvider } from "../ui";
import { LibraryPanel } from "./LibraryPanel";
import { libraryPath } from "./libraryApi";
import { instanceCommand, libraryInputFromDraft } from "./libraryLogic";

const goblin: LibraryItem = {
  id: "lib-1",
  name: "Goblin modello",
  kind: "monster",
  scope: "campaign",
  campaignId: "c1",
  size: 1,
  imageUrl: "/assets/aaaa.png",
  stats: { hpMax: 7, armorClass: 15, speed: 30 },
  tags: ["goblin"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};
const barile: LibraryItemPublic = { id: "lib-2", name: "Barile", kind: "object", scope: "global", size: 1, imageUrl: null, tags: [] };

let sockets: FakeSocket[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

function mount(actor: Actor, items: Array<LibraryItem | LibraryItemPublic>) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const q = new URL(url, "http://x").searchParams.get("q")?.toLowerCase();
    const shown = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
    return new Response(JSON.stringify({ items: shown, total: shown.length }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
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
  const view = viewFor(state, actor);
  const scene = view.scenes.find((s) => s.id === "s1")!;
  render(
    <ToastProvider>
      <RealtimeProvider campaignId="c1" client={client}>
        <LibraryPanel view={view} scene={scene} tokens={view.tokens} />
      </RealtimeProvider>
    </ToastProvider>
  );
  act(() => {
    const s = sockets.at(-1)!;
    s.open();
    s.push({ type: "snapshot", protocolVersion: PROTOCOL_VERSION, epoch: "e1", version: state.version, view });
  });
}

beforeEach(() => {
  sockets = [];
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("libreria nel client", () => {
  it("il GM cerca e con un clic crea l'istanza con token.create (id nuovo, scena attuale, PF al massimo)", async () => {
    const u = userEvent.setup();
    mount(gm, [goblin]);
    expect(await screen.findByText("Goblin modello")).toBeTruthy();
    expect(screen.getByText(/PF 7/)).toBeTruthy();
    await u.click(screen.getByRole("button", { name: "Aggiungi Goblin modello alla scena" }));
    const sent = sockets.at(-1)!.sent.filter((m) => m.type === "command").at(-1) as { command: { type: string; token: Record<string, unknown> } };
    expect(sent.command.type).toBe("token.create");
    expect(sent.command.token).toMatchObject({ name: "Goblin modello", sceneId: "s1", kind: "monster", size: 1, imageUrl: "/assets/aaaa.png", ownerUserId: null, hidden: false, health: { current: 7, max: 7, temp: 0 } });
    expect(typeof sent.command.token.id).toBe("string");
    expect(sent.command.token.id).not.toBe(goblin.id);
  });

  it("la ricerca interroga il server con q e il filtro per tipo", async () => {
    const u = userEvent.setup();
    mount(gm, [goblin]);
    await screen.findByText("Goblin modello");
    await u.type(screen.getByRole("searchbox", { name: "Cerca nella libreria" }), "xyz");
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("q=xyz"))).toBe(true));
    expect(await screen.findByText("Nessun elemento corrisponde alla ricerca.")).toBeTruthy();
    await u.clear(screen.getByRole("searchbox", { name: "Cerca nella libreria" }));
    await u.click(screen.getByRole("radio", { name: "Mostri" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("kind=monster"))).toBe(true));
  });

  it("l'eliminazione chiede conferma e chiama DELETE", async () => {
    const u = userEvent.setup();
    mount(gm, [goblin]);
    await u.click(await screen.findByRole("button", { name: "Elimina Goblin modello dalla libreria" }));
    await u.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Elimina" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/library/lib-1") && (init as RequestInit).method === "DELETE")).toBe(true));
  });

  it("il giocatore vede gli elementi in sola lettura: nessun pulsante di aggiunta o eliminazione, nessuna statistica", async () => {
    mount(luca, [barile]);
    expect(await screen.findByText("Barile")).toBeTruthy();
    expect(screen.getByText("Globale")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Aggiungi/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Elimina/ })).toBeNull();
    expect(screen.queryByText(/PF /)).toBeNull();
  });

  it("stato vuoto con indicazioni per il GM e per il giocatore", async () => {
    mount(gm, []);
    expect(await screen.findByText("Libreria vuota")).toBeTruthy();
    expect(screen.getByText(/Salva nella libreria/)).toBeTruthy();
    cleanup();
    mount(luca, []);
    expect(await screen.findByText("Il GM non ha condiviso elementi con te.")).toBeTruthy();
  });

  it("un errore del server si mostra senza rompere il pannello", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Campagna inesistente" }), { status: 404 })));
    const client = new RealtimeClient({ campaignId: "c1", url: "ws://t", createSocket: (u) => new FakeSocket(u), isOnline: () => true });
    const view = viewFor(state, gm);
    render(
      <ToastProvider>
        <RealtimeProvider campaignId="c1" client={client}>
          <LibraryPanel view={view} scene={view.scenes[0]!} tokens={[]} />
        </RealtimeProvider>
      </ToastProvider>
    );
    expect(await screen.findByText("Non riesco a caricare la libreria")).toBeTruthy();
  });
});

describe("logica della libreria", () => {
  it("libraryPath: solo i parametri usati", () => {
    expect(libraryPath({ campaignId: "c 1" })).toBe("/library?campaignId=c+1&limit=50");
    expect(libraryPath({ campaignId: "c1", q: " orco ", kind: "monster", offset: 50 })).toBe("/library?campaignId=c1&q=orco&kind=monster&limit=50&offset=50");
    expect(libraryPath({ campaignId: "c1", kind: "all" })).toBe("/library?campaignId=c1&limit=50");
  });

  it("libraryInputFromDraft: ambito campagna o globale, PF solo se il token ha la barra", () => {
    const d = { name: "  Orco ", kind: "monster" as const, size: 2, hasHealth: true, max: "30" };
    expect(libraryInputFromDraft(d, "/assets/x.png", { kind: "campaign", campaignId: "c1" })).toMatchObject({
      name: "Orco", kind: "monster", size: 2, imageUrl: "/assets/x.png", scope: "campaign", campaignId: "c1", stats: { hpMax: 30, armorClass: null, speed: null }, tags: []
    });
    const g = libraryInputFromDraft({ ...d, hasHealth: false }, null, { kind: "global" });
    expect(g).toMatchObject({ scope: "global", stats: { hpMax: null } });
    expect("campaignId" in g).toBe(false);
    expect(libraryInputFromDraft({ ...d, max: "abc" }, null, { kind: "global" }).stats.hpMax).toBeNull();
  });

  it("instanceCommand: senza PF niente barra della vita, e non si sovrappone a un token esistente", () => {
    const scene = { id: "s1", width: 1400, height: 1050, grid: { cellSize: 70, offsetX: 0, offsetY: 0 } };
    const none = instanceCommand({ ...goblin, stats: { hpMax: null, armorClass: null, speed: null } }, scene, [], "t1");
    expect(none.type === "token.create" && none.token.health).toBeNull();
    const first = instanceCommand(goblin, scene, [], "t1");
    const second = instanceCommand(goblin, scene, [first.type === "token.create" ? first.token : { x: 0, y: 0 }], "t2");
    expect(first.type === "token.create" && second.type === "token.create" && (first.token.x !== second.token.x || first.token.y !== second.token.y)).toBe(true);
  });
});
