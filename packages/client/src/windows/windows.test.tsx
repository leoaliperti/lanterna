import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, viewFor, type Actor, type CampaignState, type CampaignView } from "@lanterna/shared";
import type { SessionUser } from "../api/client";
import { resolveScreen } from "../App";
import { FakeSocket } from "../realtime/fakeSocket";
import { RealtimeClient } from "../realtime/RealtimeClient";
import { RealtimeProvider } from "../realtime/RealtimeProvider";
import { SessionProvider } from "../session/SessionProvider";
import { Table, type MapOnlyLayout } from "../table/Table";
import { gm, luca, state } from "../table/testState";
import { ToastProvider } from "../ui";
import { CombatTracker, combatToShow } from "./CombatTracker";
import { ViewFrame } from "./ViewFrame";

let sockets: FakeSocket[] = [];
const cur = () => sockets[sockets.length - 1]!;
const sentOf = (type: string) => cur().sent.filter((m) => m.type === type);

const marta: SessionUser = { id: "gm", name: "Marta", email: "m@example.org", role: "admin" };

function client() {
  return new RealtimeClient({
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
}

function mount(ui: React.ReactNode, view: CampaignView) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ user: marta }), { status: 200 })));
  const c = client();
  render(
    <ToastProvider>
      <SessionProvider>
        <RealtimeProvider campaignId="c1" client={c}>
          {ui}
        </RealtimeProvider>
      </SessionProvider>
    </ToastProvider>
  );
  act(() => {
    cur().open();
    cur().push({ type: "snapshot", protocolVersion: PROTOCOL_VERSION, epoch: "e1", version: view.version, view });
  });
  return c;
}

function mountTable(actor: Actor, mapOnly?: MapOnlyLayout, st: CampaignState = state) {
  return mount(<Table user={marta} campaignName="Campagna" mapOnly={mapOnly} />, viewFor(st, actor));
}

beforeEach(() => {
  sockets = [];
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined
  }));
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("route delle viste", () => {
  it("le viste comuni per tutti, scena e vista giocatore solo per il GM", () => {
    expect(resolveScreen("/table", "authenticated", "player")).toBe("table");
    expect(resolveScreen("/view/map", "authenticated", "player")).toBe("view");
    expect(resolveScreen("/view/chat", "authenticated", "player")).toBe("view");
    expect(resolveScreen("/view/player/luca", "authenticated", "player")).toBe("redirect-home");
    expect(resolveScreen("/view/scene/s2", "authenticated", "player")).toBe("redirect-home");
    expect(resolveScreen("/view/player/luca", "authenticated", "admin")).toBe("view");
    expect(resolveScreen("/view/player/luca", "anonymous", undefined)).toBe("login");
    expect(resolveScreen("/view/nulla", "authenticated", "admin")).toBe("redirect-home");
  });
});

describe("vista giocatore (finestra del GM con viewAs)", () => {
  const layout: MapOnlyLayout = { title: "Vista di Luca", readOnly: true, tilesAs: "luca" };

  it("banner 'Stai guardando come', sola lettura, niente strumenti, niente annulla da tastiera", async () => {
    // La connessione vera usa ?viewAs=luca: il server manda la vista di Luca (qui simulata con viewFor).
    mountTable(luca, layout);
    expect(await screen.findByRole("note", { name: /Stai guardando come Luca/ })).toBeTruthy();
    expect(screen.getByText("Sola lettura")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Vista di Luca" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Nuovo token" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Annulla/ })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Pannello laterale" })).toBeNull();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(sentOf("undo")).toHaveLength(0);
    expect(sentOf("command")).toHaveLength(0);
  });
});

describe("finestre del GM", () => {
  it("scena precisa: la finestra mostra quella scena senza attivarla", async () => {
    mountTable(gm, { title: "Scena: Bosco", sceneId: "s2" });
    expect(await screen.findByRole("heading", { name: "Scena: Bosco" })).toBeTruthy();
    expect(document.title).toBe("Scena: Bosco - Lanterna");
    expect(sentOf("command")).toHaveLength(0); // nessun scene.activate
    expect(screen.queryByText("Sei il GM di questo tavolo")).toBeNull();
  });

  it("menu 'Apri in nuova finestra' e pulsante del pannello: window.open con URL stabile e nome per vista", async () => {
    const u = userEvent.setup();
    const open = vi.fn(() => ({ focus: () => undefined }) as unknown as Window);
    vi.stubGlobal("open", open);
    mountTable(gm);
    await u.click(await screen.findByRole("button", { name: "Apri in nuova finestra" }));
    await u.click(await screen.findByRole("menuitem", { name: "Vista di Luca" }));
    expect(open).toHaveBeenLastCalledWith(expect.stringMatching(/#\/view\/player\/luca$/), "lanterna-view-player-luca", expect.stringContaining("popup=yes"));

    await u.click(screen.getByRole("tab", { name: /Chat/ }));
    await u.click(screen.getByRole("button", { name: "Apri Chat in una nuova finestra" }));
    expect(open).toHaveBeenLastCalledWith(expect.stringMatching(/#\/view\/chat$/), "lanterna-view-chat", expect.any(String));
  });

  it("popup bloccato: avviso non bloccante", async () => {
    const u = userEvent.setup();
    vi.stubGlobal("open", vi.fn(() => null));
    mountTable(gm);
    await u.click(await screen.findByRole("button", { name: "Apri in nuova finestra" }));
    await u.click(await screen.findByRole("menuitem", { name: "Mappa" }));
    expect(await screen.findByText("Finestra bloccata dal browser")).toBeTruthy();
  });
});

describe("tracker del combattimento", () => {
  const fight: CampaignState = {
    ...state,
    combats: [
      {
        sceneId: "s1",
        started: true,
        round: 2,
        turnId: "p2",
        step: 1,
        maxStep: 1,
        participants: [
          { id: "p1", tokenId: "pg-luca", name: null, initiative: 18, hidden: false, hideInitiative: false },
          { id: "p2", tokenId: null, name: "Goblin", initiative: 12, hidden: false, hideInitiative: true },
          { id: "p3", tokenId: null, name: "Ombra", initiative: 5, hidden: true, hideInitiative: false }
        ]
      }
    ]
  };

  it("il giocatore vede il tracker filtrato dal server; il GM passa il turno con un comando", async () => {
    const u = userEvent.setup();
    const asLuca = viewFor(fight, luca);
    mount(<CombatTracker view={asLuca} canControl={false} />, asLuca);
    expect(screen.getByRole("heading", { name: "Round 2" })).toBeTruthy();
    expect(screen.queryByText("Ombra")).toBeNull(); // nascosto: non arriva al giocatore
    expect(screen.getByText("Goblin").closest("li")?.getAttribute("aria-current")).toBe("true");
    expect(screen.getByLabelText("Iniziativa non nota")).toBeTruthy(); // iniziativa nascosta
    expect(screen.queryByRole("button", { name: /Turno successivo/ })).toBeNull();
    cleanup();

    const asGm = viewFor(fight, gm);
    expect(combatToShow(asGm)?.participants).toHaveLength(3);
    mount(<CombatTracker view={asGm} canControl />, asGm);
    await u.click(screen.getByRole("button", { name: /Turno successivo/ }));
    expect(sentOf("command").at(-1)).toMatchObject({ command: { type: "combat.next", sceneId: "s1" } });
  });

  it("senza combattimento: stato vuoto", () => {
    const v = viewFor(state, gm);
    mount(<CombatTracker view={v} canControl />, v);
    expect(screen.getByText("Nessun combattimento")).toBeTruthy();
  });
});

describe("cornice delle finestre secondarie", () => {
  it("nome della vista, stato della connessione e titolo della finestra", () => {
    mount(
      <ViewFrame title="Chat" layout="panel">
        <p>contenuto</p>
      </ViewFrame>,
      viewFor(state, gm)
    );
    expect(screen.getByRole("heading", { name: "Chat" })).toBeTruthy();
    expect(screen.getByTitle("Connesso")).toBeTruthy();
    expect(document.title).toBe("Chat - Lanterna");
    expect(screen.getByRole("main", { name: "Chat" })).toBeTruthy();
  });
});
