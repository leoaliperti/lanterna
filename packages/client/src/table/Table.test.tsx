import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, viewFor, type Actor } from "@lanterna/shared";
import type { SessionUser } from "../api/client";
import { FakeSocket } from "../realtime/fakeSocket";
import { RealtimeClient } from "../realtime/RealtimeClient";
import { RealtimeProvider } from "../realtime/RealtimeProvider";
import { SessionProvider } from "../session/SessionProvider";
import { ToastProvider } from "../ui";
import { Table } from "./Table";
import { gm, luca, state } from "./testState";
import { historyShortcut } from "./shortcuts";

let sockets: FakeSocket[] = [];
const cur = () => sockets[sockets.length - 1]!;

const users: Record<string, SessionUser> = {
  gm: { id: "gm", name: "Marta", email: "m@example.org", role: "admin" },
  luca: { id: "luca", name: "Luca", email: "l@example.org", role: "player" }
};

function mount(actor: Actor) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ user: users[actor.userId] }), { status: 200 }))
  );
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
  return client;
}

beforeEach(() => {
  sockets = [];
  // Schermo largo (sidebar visibile) e movimento ridotto (sheet e alert si montano/smontano subito).
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

const panel = () => within(screen.getByRole("complementary", { name: "Pannello laterale" }));
const panelFind = (text: string) => screen.findByRole("complementary", { name: "Pannello laterale" }).then((p) => within(p).findByText(text));
const sentOf = (type: string) => cur().sent.filter((m) => m.type === type);

describe("tavolo del GM", () => {
  it("mostra gli strumenti del GM e il token nascosto nell'elenco", async () => {
    mount(gm);
    expect(await screen.findByRole("button", { name: "Nuovo token" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Scena" })).toBeTruthy();
    expect(panel().getByText("drago")).toBeTruthy();
    expect(panel().getByText("Nascosto")).toBeTruthy();
  });

  it("Annulla e Ripeti inviano undo/redo con requestId; gli errori diventano toast leggeri", async () => {
    const u = userEvent.setup();
    mount(gm);
    await u.click(await screen.findByRole("button", { name: /^Annulla/ }));
    const undo = sentOf("undo")[0] as { requestId: string };
    expect(undo.requestId).toBeTruthy();
    act(() => cur().push({ type: "ack", requestId: undo.requestId, version: state.version + 1 }));
    await u.click(screen.getByRole("button", { name: /^Ripeti/ }));
    const redo = sentOf("redo")[0] as { requestId: string };
    act(() => cur().push({ type: "error", requestId: redo.requestId, code: "FORBIDDEN", message: "azione riservata al GM" }));
    expect(await screen.findByText("Azione non consentita")).toBeTruthy();
  });

  it("scorciatoie da tastiera: Ctrl+Z annulla, Maiusc+Ctrl+Z ripete, ma non dentro un campo di testo", async () => {
    mount(gm);
    await screen.findByRole("button", { name: "Nuovo token" });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(sentOf("undo")).toHaveLength(1);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    expect(sentOf("redo")).toHaveLength(1);
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(sentOf("undo")).toHaveLength(2);
    const search = screen.getByRole("searchbox", { name: "Cerca un token" });
    fireEvent.keyDown(search, { key: "z", ctrlKey: true });
    expect(sentOf("undo")).toHaveLength(2);
  });

  it("il pannello Token filtra per categoria e per testo", async () => {
    const u = userEvent.setup();
    mount(gm);
    await panelFind("drago");
    await u.click(screen.getByRole("radio", { name: "PG" }));
    expect(panel().queryByText("drago")).toBeNull();
    expect(panel().getByText("pg-luca")).toBeTruthy();
    await u.click(screen.getByRole("radio", { name: "Tutti" }));
    await u.type(screen.getByRole("searchbox", { name: "Cerca un token" }), "dra");
    expect(panel().getByText("drago")).toBeTruthy();
    expect(panel().queryByText("pg-luca")).toBeNull();
  });

  it("nuovo token: invia token.create con id, scena e tipo, e non modifica la vista da solo", async () => {
    const u = userEvent.setup();
    mount(gm);
    await u.click(await screen.findByRole("button", { name: "Nuovo token" }));
    const dialog = await screen.findByRole("dialog", { name: "Nuovo token" });
    await u.type(within(dialog).getByLabelText("Nome"), "Goblin");
    await u.click(within(dialog).getByRole("radio", { name: "Mostro" }));
    await u.click(within(dialog).getByRole("switch", { name: "Barra della vita" }));
    await u.click(within(dialog).getByRole("button", { name: "Prono" }));
    await u.click(within(dialog).getByRole("button", { name: "Aggiungi" }));
    const sent = sentOf("command").at(-1) as { command: { type: string; token: Record<string, unknown> } };
    expect(sent.command.type).toBe("token.create");
    expect(sent.command.token).toMatchObject({
      name: "Goblin",
      sceneId: "s1",
      kind: "monster",
      hidden: false,
      health: { current: 10, max: 10, temp: 0 },
      conditions: [{ id: "prone", name: "Prono" }],
      ownerUserId: null
    });
    expect(String(sent.command.token.id)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(screen.queryByText("Goblin")).toBeNull(); // il server decide: niente effetto ottimistico
  });

  it("la vita attuale oltre il massimo e' rifiutata nel modulo senza inviare nulla", async () => {
    const u = userEvent.setup();
    mount(gm);
    await u.click(await screen.findByRole("button", { name: "Nuovo token" }));
    const dialog = await screen.findByRole("dialog", { name: "Nuovo token" });
    await u.type(within(dialog).getByLabelText("Nome"), "Orco");
    await u.click(within(dialog).getByRole("switch", { name: "Barra della vita" }));
    await u.clear(within(dialog).getByLabelText("Attuali"));
    await u.type(within(dialog).getByLabelText("Attuali"), "50");
    await u.click(within(dialog).getByRole("button", { name: "Aggiungi" }));
    expect(await within(dialog).findByText(/non può superare il massimo/)).toBeTruthy();
    expect(sentOf("command")).toHaveLength(0);
  });

  it("modifica: invia solo i campi cambiati (nascondi + note)", async () => {
    const u = userEvent.setup();
    mount(gm);
    await u.click(await panelFind("drago"));
    const dialog = await screen.findByRole("dialog", { name: "Modifica token" });
    expect((within(dialog).getByLabelText(/Note del GM/) as HTMLTextAreaElement).value).toBe("segreto del GM");
    await u.click(within(dialog).getByRole("switch", { name: "Nascosto ai giocatori" }));
    await u.click(within(dialog).getByRole("button", { name: "Salva" }));
    const sent = sentOf("command").at(-1) as { command: unknown };
    expect(sent.command).toEqual({ type: "token.update", tokenId: "drago", patch: { hidden: false } });
  });
});

describe("tavolo del giocatore", () => {
  it("niente strumenti del GM; vita solo del proprio token; nessun token nascosto", async () => {
    mount(luca);
    await panelFind("pg-luca");
    expect(screen.queryByRole("button", { name: "Nuovo token" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Scena" })).toBeNull();
    expect(panel().queryByText("drago")).toBeNull();
    expect(panel().getByText("12/20")).toBeTruthy(); // la sua vita
    expect(panel().queryByText("8/8")).toBeNull(); // quella di Sara non e' stata inviata
    expect(document.body.textContent).not.toContain("segreto del GM");
  });

  it("il proprietario puo' cambiare solo le condizioni del proprio token", async () => {
    const u = userEvent.setup();
    mount(luca);
    await u.click(await panelFind("pg-luca"));
    const dialog = await screen.findByRole("dialog", { name: /Condizioni di pg-luca/ });
    expect(within(dialog).queryByLabelText("Nome")).toBeNull();
    expect(within(dialog).queryByLabelText(/Note del GM/)).toBeNull();
    await u.click(within(dialog).getByRole("button", { name: "Avvelenato" }));
    await u.click(within(dialog).getByRole("button", { name: "Salva" }));
    const sent = sentOf("command").at(-1) as { command: { patch: { conditions: Array<{ id: string }> } } };
    expect(Object.keys((sent.command as { patch: object }).patch)).toEqual(["conditions"]);
    expect(sent.command.patch.conditions.map((c) => c.id)).toEqual(["prone", "poisoned"]);
  });

  it("un token altrui non apre la scheda", async () => {
    const u = userEvent.setup();
    mount(luca);
    await u.click(await panelFind("pg-sara"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("connessione", () => {
  it("se cade mostra un avviso non invasivo e lo toglie alla riconnessione", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mount(gm);
      expect(screen.queryByText("Riconnessione in corso")).toBeNull();
      act(() => cur().drop());
      expect(await screen.findByText("Riconnessione in corso")).toBeTruthy();
      expect((screen.getByRole("button", { name: /^Annulla/ }) as HTMLButtonElement).disabled).toBe(true);
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      act(() => {
        cur().open();
        cur().push({ type: "delta", epoch: "e1", fromVersion: state.version, toVersion: state.version, events: [] });
      });
      expect(screen.queryByText("Riconnessione in corso")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scorciatoie", () => {
  const base = { altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, target: null };
  it("riconosce annulla e ripeti, ignora i campi di testo", () => {
    expect(historyShortcut({ ...base, key: "z", metaKey: true })).toBe("undo");
    expect(historyShortcut({ ...base, key: "Z", metaKey: true, shiftKey: true })).toBe("redo");
    expect(historyShortcut({ ...base, key: "y", ctrlKey: true })).toBe("redo");
    expect(historyShortcut({ ...base, key: "z" })).toBeNull();
    expect(historyShortcut({ ...base, key: "z", ctrlKey: true, altKey: true })).toBeNull();
    const input = document.createElement("input");
    expect(historyShortcut({ ...base, key: "z", ctrlKey: true, target: input })).toBeNull();
  });
});
