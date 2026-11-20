import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, blankDoc, snapshotOf, viewFor, type Actor, type SheetDoc, type SheetRecord, type SheetSummary } from "@lanterna/shared";
import type { SessionUser } from "../api/client";
import { FakeSocket } from "../realtime/fakeSocket";
import { RealtimeClient } from "../realtime/RealtimeClient";
import { RealtimeProvider } from "../realtime/RealtimeProvider";
import { SessionProvider } from "../session/SessionProvider";
import { Table } from "../table/Table";
import { gm, luca, state } from "../table/testState";
import { ToastProvider } from "../ui";

/* Dati FITTIZI. Il server e' simulato: qui si verifica cio' che fa l'interfaccia (i permessi veri sono nei test del server). */

let sockets: FakeSocket[] = [];
const cur = () => sockets[sockets.length - 1]!;

const users: Record<string, SessionUser> = {
  gm: { id: "gm", name: "Marta", email: "m@example.org", role: "admin" },
  luca: { id: "luca", name: "Luca", email: "l@example.org", role: "player" }
};

function heroDoc(): SheetDoc {
  const d = blankDoc("Eroe di prova");
  return {
    ...d,
    sheet: { ...d.sheet, abilities: { ...d.sheet.abilities, dex: 14, wis: 12 }, skills: { perception: "proficient" }, conditions: ["poisoned"] },
    extras: {
      ...d.extras,
      inventory: [{ id: "i1", name: "Lanterna cieca", quantity: 1, weight: 2, equipped: false, notes: "" }],
      spells: [{ id: "sp1", name: "Scintilla di prova", level: 1, prepared: false, notes: "" }]
    }
  };
}

function record(id: string, kind: "pc" | "monster", name: string, doc: SheetDoc, version = 1): SheetRecord {
  const named = { ...doc, sheet: { ...doc.sheet, name } };
  return { id, campaignId: "c1", kind, name, ownerUserId: kind === "pc" ? "luca" : null, tokenId: null, version, updatedAt: "2026-01-01T00:00:00.000Z", doc: named, ...snapshotOf(named) };
}

interface Api {
  records: Map<string, SheetRecord>;
  puts: Array<{ id: string; body: { version: number; doc?: SheetDoc } }>;
  conflict: boolean;
}

function installApi(actor: Actor, records: SheetRecord[]): Api {
  const api: Api = { records: new Map(records.map((r) => [r.id, r])), puts: [], conflict: false };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/auth/get-session")) return json({ user: users[actor.userId] });
      if (url.startsWith("/api/content/lib1")) {
        return json({ id: "lib1", kind: "spell", name: "Raggio di prova", source: "Raccolta di prova", data: { level: 2, text: "Testo inventato." } });
      }
      if (url.startsWith("/api/content")) {
        const q = new URL(url, "http://x").searchParams;
        if (q.get("kind") === "spell") return json({ items: [{ id: "lib1", kind: "spell", name: "Raggio di prova", source: "Raccolta di prova" }], total: 1 });
        return json({ items: [], total: 0 });
      }
      const m = /^\/api\/campaigns\/c1\/sheets(?:\/([^/?]+))?/.exec(url);
      if (m) {
        const id = m[1];
        if (!id) return json({ sheets: [...api.records.values()].map(({ doc: _d, ...s }) => (void _d, s)) });
        const rec = api.records.get(id);
        if (!rec) return json({ error: "Scheda inesistente" }, 404);
        if (method === "PUT") {
          const body = JSON.parse(String(init?.body)) as { version: number; doc?: SheetDoc };
          api.puts.push({ id, body });
          if (api.conflict || body.version !== rec.version) return json({ error: "x", code: "CONFLICT" }, 409);
          const next = { ...rec, version: rec.version + 1, ...(body.doc ? { doc: body.doc, name: body.doc.sheet.name, ...snapshotOf(body.doc) } : {}) };
          api.records.set(id, next);
          return json(next);
        }
        return json(rec);
      }
      return json({}, 404);
    })
  );
  return api;
}

function mount(actor: Actor): RealtimeClient {
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

const side = () => within(screen.getByRole("complementary", { name: "Pannello laterale" }));
const sent = (type: string) => cur().sent.filter((m) => m.type === type);

async function openSheetsTab(u: ReturnType<typeof userEvent.setup>) {
  await u.click(await screen.findByRole("tab", { name: "Schede" }));
}

describe("elenco e apertura", () => {
  it("il giocatore vede la propria scheda, il GM anche lo statblock; la ricerca filtra", async () => {
    const u = userEvent.setup();
    installApi(luca, [record("s1", "pc", "Eroe di prova", heroDoc())]);
    mount(luca);
    await openSheetsTab(u);
    expect(await side().findByText("Eroe di prova")).toBeTruthy();
    expect(side().queryByRole("button", { name: "Mostro" })).toBeNull();
    cleanup();
    sockets = [];

    installApi(gm, [record("s1", "pc", "Eroe di prova", heroDoc()), record("s2", "monster", "Gufo di prova", blankDoc("Gufo di prova", "monster"))]);
    mount(gm);
    await openSheetsTab(u);
    expect(await side().findByText("Gufo di prova")).toBeTruthy();
    expect(side().getByRole("button", { name: "Mostro" })).toBeTruthy();
    await u.type(side().getByRole("searchbox", { name: "Cerca una scheda" }), "gufo");
    expect(side().queryByText("Eroe di prova")).toBeNull();
    expect(side().getByText("Gufo di prova")).toBeTruthy();
  });
});

describe("scheda aperta", () => {
  async function openHero(u: ReturnType<typeof userEvent.setup>, extra: SheetRecord[] = []) {
    const api = installApi(luca, [record("s1", "pc", "Eroe di prova", heroDoc()), ...extra]);
    mount(luca);
    await openSheetsTab(u);
    await u.click(await side().findByRole("button", { name: /Eroe di prova/ }));
    const dialog = await screen.findByRole("dialog", { name: "Schede" });
    await within(dialog).findByRole("article", { name: "Scheda di Eroe di prova" });
    return { api, dialog: within(dialog) };
  }

  it("un clic su un'abilita' invia roll.request con la formula della scheda e lo svantaggio delle condizioni", async () => {
    const u = userEvent.setup();
    const { dialog } = await openHero(u);
    await u.click(dialog.getByRole("tab", { name: "Abilita'" }));
    await u.click(await dialog.findByRole("button", { name: /Percezione/ }));
    const req = sent("roll.request");
    expect(req).toHaveLength(1);
    expect(req[0]).toMatchObject({ formula: "1d20+3 dis", visibility: "public" });
    expect(String(req[0]!.label)).toContain("Percezione");
  });

  it("la ricerca filtra le abilita'", async () => {
    const u = userEvent.setup();
    const { dialog } = await openHero(u);
    await u.click(dialog.getByRole("tab", { name: "Abilita'" }));
    await u.type(dialog.getByRole("searchbox", { name: "Cerca nella scheda" }), "furt");
    expect(await dialog.findByRole("button", { name: /Furtivita'/ })).toBeTruthy();
    expect(dialog.queryByRole("button", { name: /Percezione/ })).toBeNull();
  });

  it("il tiro salvezza e la prova di caratteristica passano dal server", async () => {
    const u = userEvent.setup();
    const { dialog } = await openHero(u);
    await u.click(dialog.getByRole("button", { name: /Tiro salvezza di Destrezza/ }));
    expect(sent("roll.request")[0]).toMatchObject({ formula: "1d20+2" });
    await u.click(dialog.getByRole("button", { name: /Prova di Saggezza/ }));
    expect(sent("roll.request")[1]).toMatchObject({ formula: "1d20+1 dis" });
  });

  it("le modifiche si salvano con la versione letta e il valore derivato si aggiorna", async () => {
    const u = userEvent.setup();
    const { api, dialog } = await openHero(u);
    await u.click(dialog.getByRole("tab", { name: "Combattimento" }));
    expect(await dialog.findByText("PF", { exact: false })).toBeTruthy();
    await u.click(dialog.getByRole("button", { name: "Danno" }));
    await waitFor(() => expect(api.puts).toHaveLength(1), { timeout: 3000 });
    expect(api.puts[0]).toMatchObject({ id: "s1", body: { version: 1 } });
    expect(api.puts[0]!.body.doc!.sheet.hp.current).toBe(7);
    expect(await dialog.findByText("Salvato")).toBeTruthy();
    expect(api.records.get("s1")!.version).toBe(2);
  });

  it("un conflitto mostra la scelta tra la versione piu' recente e le proprie modifiche", async () => {
    const u = userEvent.setup();
    const { api, dialog } = await openHero(u);
    api.conflict = true;
    await u.click(dialog.getByRole("tab", { name: "Combattimento" }));
    await u.click(dialog.getByRole("button", { name: "Danno" }));
    expect(await dialog.findByText("La scheda e' cambiata altrove", undefined, { timeout: 3000 })).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Carica la versione piu' recente" })).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Tieni le mie modifiche" })).toBeTruthy();
  });

  it("piu' schede aperte insieme: una linguetta per scheda e la chiusura", async () => {
    const u = userEvent.setup();
    const { dialog } = await openHero(u, [record("s3", "pc", "Seconda eroina", blankDoc("Seconda eroina"))]);
    // Riapre l'elenco dal pannello laterale mentre la finestra e' aperta: si chiude la finestra e si apre la seconda.
    await u.keyboard("{Escape}");
    await u.click(await side().findByRole("button", { name: /Seconda eroina/ }));
    const dlg = within(await screen.findByRole("dialog", { name: "Schede" }));
    const tabs = dlg.getAllByRole("tab", { name: /Eroe di prova|Seconda eroina/ });
    expect(tabs.map((t) => t.textContent)).toEqual(["Eroe di prova", "Seconda eroina"]);
    await u.click(dlg.getByRole("button", { name: "Chiudi Seconda eroina" }));
    expect(dlg.queryByRole("tab", { name: "Seconda eroina" })).toBeNull();
    expect(dialog).toBeTruthy();
  });

  it("incantesimi: aggiunta dalla libreria importata", async () => {
    const u = userEvent.setup();
    const { api, dialog } = await openHero(u);
    await u.click(dialog.getByRole("tab", { name: "Magia" }));
    await u.click(await dialog.findByRole("button", { name: "Dalla libreria" }));
    await u.click(await dialog.findByText("Raggio di prova"));
    await waitFor(() => expect(api.puts.length).toBeGreaterThan(0), { timeout: 3000 });
    const names = api.puts.at(-1)!.body.doc!.extras.spells.map((s) => s.name);
    expect(names).toContain("Raggio di prova");
  });
});
