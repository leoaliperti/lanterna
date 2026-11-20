import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, viewFor, type Actor, type CampaignState } from "@lanterna/shared";
import type { SessionUser } from "../api/client";
import { FakeSocket } from "../realtime/fakeSocket";
import { RealtimeClient } from "../realtime/RealtimeClient";
import { RealtimeProvider } from "../realtime/RealtimeProvider";
import { SessionProvider } from "../session/SessionProvider";
import { Table } from "../table/Table";
import { gm, luca, state as baseState, token } from "../table/testState";
import { ToastProvider } from "../ui";

/* Tracker, azioni di gruppo, bersagli, effetti e avvisi nel tavolo reale (WebGL assente in jsdom: il canvas ripiega sull'elenco). */

let sockets: FakeSocket[] = [];
const cur = () => sockets[sockets.length - 1]!;

const users: Record<string, SessionUser> = {
  gm: { id: "gm", name: "Marta", email: "m@example.org", role: "admin" },
  luca: { id: "luca", name: "Luca", email: "l@example.org", role: "player" }
};

const SECRET_ENTRY = "VoceSegretaXYZ";
const SECRET_EFFECT = "EffettoSegretoXYZ";

const state: CampaignState = {
  ...baseState,
  tokens: [
    token({ id: "pg-luca", name: "Aldo", kind: "pc", ownerUserId: "luca", faction: "Eroi", health: { current: 12, max: 20, temp: 0 }, x: 105, y: 105,
      effects: [
        { id: "ef-b", name: "Benedizione", condition: null, remaining: 3, timing: "end", turnOf: null, secret: false, addedCondition: false },
        { id: "ef-s", name: SECRET_EFFECT, condition: null, remaining: 2, timing: "end", turnOf: null, secret: true, addedCondition: false }
      ] }),
    token({ id: "pg-sara", name: "Bea", kind: "pc", ownerUserId: "sara", faction: "Eroi", health: { current: 8, max: 8, temp: 0 }, x: 175, y: 105 }),
    token({ id: "gob1", name: "Goblin Rosso", kind: "monster", faction: "Orda", health: { current: 7, max: 7, temp: 0 }, x: 245, y: 105,
      effects: [{ id: "ef-f", name: "Fiamma", condition: { id: "poisoned", name: "Avvelenato" }, remaining: 2, timing: "end", turnOf: null, secret: false, addedCondition: true }],
      conditions: [{ id: "poisoned", name: "Avvelenato" }] }),
    token({ id: "gob2", name: "Goblin Blu", kind: "monster", faction: "Orda", hidden: true, health: { current: 7, max: 7, temp: 0 }, x: 315, y: 105 }),
    token({ id: "altra-scena", sceneId: "s2" })
  ],
  combats: [
    {
      sceneId: "s1",
      started: true,
      round: 2,
      turnId: "p1",
      step: 0,
      maxStep: 0,
      participants: [
        { id: "p1", tokenId: "pg-luca", name: null, initiative: 18, hidden: false, hideInitiative: false },
        { id: "p2", tokenId: "gob1", name: null, initiative: 12, hidden: false, hideInitiative: false },
        { id: "p3", tokenId: null, name: SECRET_ENTRY, initiative: 7, hidden: true, hideInitiative: false },
        { id: "p4", tokenId: "pg-sara", name: null, initiative: null, hidden: false, hideInitiative: false }
      ]
    }
  ],
  groups: [{ id: "g1", name: "Mostri", tokenIds: ["gob1", "gob2"] }]
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

const sentOf = (type: string) => cur().sent.filter((m) => m.type === type);
const lastCommand = () => (sentOf("command").at(-1) as { command: Record<string, unknown> }).command;
const ack = (msg: Record<string, unknown>, version = state.version + 1) => act(() => cur().push({ type: "ack", requestId: msg.requestId, version }));
let version = state.version;
const delta = (events: unknown[]) => {
  const from = version;
  version += 1;
  act(() => cur().push({ type: "delta", epoch: "e1", fromVersion: from, toVersion: version, events }));
};
beforeEach(() => {
  version = state.version;
});

async function openTab(u: ReturnType<typeof userEvent.setup>, name: string) {
  await u.click(await screen.findByRole("tab", { name }));
}

describe("tracker dell'iniziativa: GM", () => {
  it("mostra round, turno corrente e ordine; il GM vede anche le voci nascoste", async () => {
    const u = userEvent.setup();
    mount(gm);
    await openTab(u, "Iniziativa");
    expect(await screen.findByText("Round 2, turno di Aldo")).toBeTruthy();
    const rows = within(screen.getByRole("list", { name: "Ordine di iniziativa" })).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(rows[0]!.getAttribute("aria-current")).toBe("true");
    expect(rows[1]!.getAttribute("aria-current")).toBeNull();
    expect(within(rows[0]!).getByText("Di turno")).toBeTruthy();
    expect(within(rows[2]!).getByText(SECRET_ENTRY)).toBeTruthy();
    expect(within(rows[2]!).getByText("Nascosto ai giocatori")).toBeTruthy();
  });

  it("avanti, indietro e termina (con conferma) inviano i comandi di turno", async () => {
    const u = userEvent.setup();
    mount(gm);
    await openTab(u, "Iniziativa");
    await u.click(await screen.findByRole("button", { name: "Avanti" }));
    expect(lastCommand()).toEqual({ type: "combat.next", sceneId: "s1" });
    await u.click(screen.getByRole("button", { name: "Indietro" }));
    expect(lastCommand()).toEqual({ type: "combat.previous", sceneId: "s1" });
    await u.click(screen.getByRole("button", { name: "Termina" }));
    const alert = await screen.findByRole("alertdialog", { name: "Terminare il combattimento?" });
    const before = sentOf("command").length;
    await u.click(within(alert).getByRole("button", { name: "Annulla" }));
    expect(sentOf("command")).toHaveLength(before); // annullato: niente inviato
    await u.click(screen.getByRole("button", { name: "Termina" }));
    await u.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Termina" }));
    expect(lastCommand()).toEqual({ type: "combat.end", sceneId: "s1" });
  });

  it("il tiro lo fa il server: il client manda solo i partecipanti senza valore, il bonus e il modo", async () => {
    const u = userEvent.setup();
    mount(gm);
    await openTab(u, "Iniziativa");
    const bonus = await screen.findByLabelText("Bonus");
    await u.clear(bonus);
    await u.type(bonus, "3");
    await u.click(screen.getByRole("radio", { name: "Vantaggio" }));
    await u.click(screen.getByRole("button", { name: "Tira per chi manca (1)" }));
    expect(sentOf("initiative.roll")[0]).toMatchObject({ sceneId: "s1", sort: true, rolls: [{ participantId: "p4", bonus: 3, mode: "advantage" }] });
    // Nessun valore di iniziativa esce dal client.
    expect(JSON.stringify(sentOf("initiative.roll")[0])).not.toMatch(/"(initiative|total|natural)"/);
    await u.click(screen.getByRole("button", { name: "Tira l'iniziativa di Goblin Rosso" }));
    expect(sentOf("initiative.roll")[1]).toMatchObject({ rolls: [{ participantId: "p2", bonus: 3 }] });
  });

  it("valore a mano, voce libera e riordino da tastiera", async () => {
    const u = userEvent.setup();
    mount(gm);
    await openTab(u, "Iniziativa");
    const field = await screen.findByLabelText("Iniziativa di Goblin Rosso");
    await u.clear(field);
    await u.type(field, "20{Enter}");
    expect(lastCommand()).toEqual({ type: "combat.setInitiative", sceneId: "s1", values: [{ participantId: "p2", initiative: 20 }] });

    await u.type(screen.getByLabelText("Voce libera"), "Trappola");
    await u.click(screen.getByRole("button", { name: "Aggiungi voce" }));
    expect(lastCommand()).toMatchObject({ type: "combat.add", sceneId: "s1", participant: { tokenId: null, name: "Trappola", hidden: false } });

    screen.getByRole("button", { name: /^Sposta Aldo/ }).focus();
    await u.keyboard("{ArrowDown}");
    expect(lastCommand()).toEqual({ type: "combat.reorder", sceneId: "s1", participantId: "p1", toIndex: 1 });
    screen.getByRole("button", { name: /^Sposta Aldo/ }).focus();
    await u.keyboard("{ArrowUp}"); // gia' in cima: niente
    expect(sentOf("command").filter((m) => (m as { command: { type: string } }).command.type === "combat.reorder")).toHaveLength(1);
  });

  it("aggiunge i token selezionati e quelli scelti dal menu", async () => {
    const u = userEvent.setup();
    mount(gm);
    await openTab(u, "Iniziativa");
    // Con tutti i token della scena visibili al GM, resta da aggiungere solo il goblin nascosto.
    await u.click(await screen.findByRole("button", { name: "Aggiungi token" }));
    await u.click(await screen.findByRole("menuitem", { name: "Goblin Blu" }));
    expect(lastCommand()).toMatchObject({ type: "combat.add", participant: { tokenId: "gob2", name: null } });
  });
});

describe("tracker dell'iniziativa: giocatore", () => {
  it("vede solo cio' che il server invia: niente voci nascoste, niente comandi", async () => {
    const u = userEvent.setup();
    mount(luca);
    await openTab(u, "Iniziativa");
    expect(await screen.findByText("Round 2, turno di Aldo")).toBeTruthy();
    const rows = within(screen.getByRole("list", { name: "Ordine di iniziativa" })).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.getAttribute("aria-current")).toBe("true");
    expect(document.body.textContent).not.toContain(SECRET_ENTRY);
    expect(screen.queryByRole("button", { name: "Avanti" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Sposta/ })).toBeNull();
    expect(screen.queryByLabelText("Bonus")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Bersagli" })).toBeNull();
  });
});

describe("bersagli, gruppi e azioni di gruppo", () => {
  it("seleziona per categoria, applica un danno con un solo group.apply e lo annulla dalla notifica", async () => {
    const u = userEvent.setup();
    mount(gm);
    await openTab(u, "Bersagli");
    await u.click(await screen.findByRole("button", { name: "Solo mostri" }));
    expect(await screen.findByText("2 token selezionati", { selector: "h3" })).toBeTruthy();
    const bar = screen.getByRole("toolbar", { name: "Azioni su 2 token" });
    await u.click(within(bar).getByRole("button", { name: "Danno" }));
    const dialog = await screen.findByRole("dialog", { name: "Danno: 2 token" });
    await u.type(within(dialog).getByLabelText("Danni"), "7");
    await u.click(within(dialog).getByRole("button", { name: "Applica" }));
    const sent = sentOf("command").at(-1) as { requestId: string; command: unknown };
    expect(sent.command).toEqual({ type: "group.apply", target: { kind: "tokens", tokenIds: ["gob1", "gob2"] }, action: { kind: "damage", amount: 7 } });
    ack(sent);
    const toasts = within(await screen.findByRole("region", { name: "Notifiche" }));
    expect(await toasts.findByText("Danno 7 a 2 token")).toBeTruthy();
    await u.click(toasts.getByRole("button", { name: "Annulla" }));
    expect(sentOf("undo")).toHaveLength(1);
  });

  it("valori non validi non inviano nulla", async () => {
    const u = userEvent.setup();
    mount(gm);
    await openTab(u, "Bersagli");
    await u.click(await screen.findByRole("button", { name: "Solo PG" }));
    await u.click(within(await screen.findByRole("toolbar", { name: "Azioni su 2 token" })).getByRole("button", { name: "Cura" }));
    const dialog = await screen.findByRole("dialog", { name: "Cura: 2 token" });
    await u.type(within(dialog).getByLabelText("Punti ferita da curare"), "-4");
    await u.click(within(dialog).getByRole("button", { name: "Applica" }));
    expect(await within(dialog).findByText("Un numero intero, da 0 in su.")).toBeTruthy();
    expect(sentOf("command")).toHaveLength(0);
  });

  it("condizione e spostamento: un solo group.apply ciascuno", async () => {
    const u = userEvent.setup();
    mount(gm);
    await openTab(u, "Bersagli");
    await u.click(await screen.findByRole("button", { name: "Fazione: Orda" }));
    const bar = await screen.findByRole("toolbar", { name: "Azioni su 2 token" });
    await u.click(within(bar).getByRole("button", { name: "Condizione" }));
    let dialog = await screen.findByRole("dialog", { name: "Condizione: 2 token" });
    await u.click(within(dialog).getByRole("button", { name: /^Condizione:/ }));
    await u.click(await screen.findByRole("menuitemradio", { name: "Prono" }));
    await u.click(within(dialog).getByRole("button", { name: "Applica" }));
    expect(lastCommand()).toMatchObject({ type: "group.apply", action: { kind: "addCondition", condition: { id: "prone", name: "Prono" } } });
    ack(sentOf("command").at(-1)!);

    await u.click(within(await screen.findByRole("toolbar", { name: "Azioni su 2 token" })).getByRole("button", { name: "Sposta" }));
    dialog = await screen.findByRole("dialog", { name: "Sposta: 2 token" });
    const right = within(dialog).getByLabelText(/Celle a destra/);
    await u.clear(right);
    await u.type(right, "2");
    await u.click(within(dialog).getByRole("button", { name: "Applica" }));
    expect(lastCommand()).toMatchObject({ type: "group.apply", action: { kind: "move", dx: 140, dy: 0 } });
  });

  it("gruppi salvati: crea, richiama con un clic, elimina", async () => {
    const u = userEvent.setup();
    mount(gm);
    await openTab(u, "Bersagli");
    await u.click(await screen.findByRole("button", { name: "Solo PG" }));
    await u.click(screen.getByRole("button", { name: "Salva la selezione" }));
    const dialog = await screen.findByRole("dialog", { name: "Nuovo gruppo" });
    await u.type(within(dialog).getByLabelText("Nome del gruppo"), "Squadra A");
    await u.click(within(dialog).getByRole("button", { name: "Salva" }));
    expect(lastCommand()).toMatchObject({ type: "group.create", group: { name: "Squadra A", tokenIds: ["pg-luca", "pg-sara"] } });

    // Richiamo: il gruppo "Mostri" ha un token nascosto e uno no, entrambi di questa scena.
    await u.click(screen.getByRole("button", { name: "Nessuno" }));
    await u.click(screen.getByRole("button", { name: "Mostri (2)" }));
    expect(await screen.findByText("2 token selezionati", { selector: "h3" })).toBeTruthy();
    await u.click(screen.getByRole("button", { name: "Azioni sul gruppo Mostri" }));
    await u.click(await screen.findByRole("menuitem", { name: "Elimina il gruppo" }));
    expect(lastCommand()).toEqual({ type: "group.delete", groupId: "g1" });
  });

  it("l'elenco dei bersagli si cerca e si usa come selezione", async () => {
    const u = userEvent.setup();
    mount(gm);
    await openTab(u, "Bersagli");
    await u.type(await screen.findByRole("searchbox", { name: "Cerca un bersaglio" }), "blu");
    expect(screen.queryByRole("button", { name: /Goblin Rosso/ })).toBeNull();
    await u.click(screen.getByRole("button", { name: /Goblin Blu/ }));
    expect(await screen.findByText("1 token selezionato", { selector: "h3" })).toBeTruthy();
  });
});

describe("effetti sul token e fazione", () => {
  it("elenco con durata residua, fazione modificabile, effetto togliibile e nuovo effetto con durata", async () => {
    const u = userEvent.setup();
    mount(gm);
    await u.click(await screen.findByText("Goblin Rosso", { selector: ".l-listrow__title, span, p" }));
    const dialog = await screen.findByRole("dialog", { name: "Modifica token" });
    const effects = within(within(dialog).getByRole("region", { name: "Effetti su Goblin Rosso" }));
    expect(effects.getByText("Fiamma")).toBeTruthy();
    expect(effects.getByText(/2 round, a fine turno/)).toBeTruthy();
    expect(effects.getByText(/condizione: Avvelenato/)).toBeTruthy();

    const faction = within(dialog).getByLabelText("Fazione") as HTMLInputElement;
    expect(faction.value).toBe("Orda");
    await u.clear(faction);
    await u.type(faction, "Banda");
    await u.click(within(dialog).getByRole("button", { name: "Salva" }));
    expect(lastCommand()).toEqual({ type: "token.update", tokenId: "gob1", patch: { faction: "Banda" } });
  });

  it("togliere un effetto invia effect.remove; aggiungerlo apre il modulo con durata e momento", async () => {
    const u = userEvent.setup();
    mount(gm);
    await u.click(await screen.findByText("Goblin Rosso", { selector: ".l-listrow__title, span, p" }));
    let dialog = await screen.findByRole("dialog", { name: "Modifica token" });
    await u.click(within(dialog).getByRole("button", { name: "Togli l'effetto Fiamma" }));
    expect(lastCommand()).toEqual({ type: "effect.remove", tokenId: "gob1", effectId: "ef-f" });

    await u.click(within(dialog).getByRole("button", { name: "Aggiungi effetto" }));
    dialog = await screen.findByRole("dialog", { name: "Effetto: 1 token" });
    await u.type(within(dialog).getByLabelText("Nome dell'effetto"), "Maledizione");
    const duration = within(dialog).getByLabelText("Durata in round");
    await u.clear(duration);
    await u.type(duration, "4");
    await u.click(within(dialog).getByRole("radio", { name: "A inizio turno" }));
    await u.click(within(dialog).getByRole("switch", { name: /Segreto/ }));
    await u.click(within(dialog).getByRole("button", { name: "Applica" }));
    const cmd = lastCommand() as { type: string; target: unknown; action: { kind: string; effect: Record<string, unknown> } };
    expect(cmd.type).toBe("group.apply");
    expect(cmd.target).toEqual({ kind: "tokens", tokenIds: ["gob1"] });
    expect(cmd.action).toMatchObject({ kind: "addEffect", effect: { name: "Maledizione", remaining: 4, timing: "start", turnOf: null, secret: true, condition: null } });
  });

  it("il giocatore vede gli effetti del proprio token ma non quelli segreti, ne' la fazione", async () => {
    const u = userEvent.setup();
    mount(luca);
    await u.click(await screen.findByText("Aldo", { selector: ".l-listrow__title, span, p" }));
    const dialog = await screen.findByRole("dialog", { name: /Condizioni di Aldo/ });
    const effects = within(within(dialog).getByRole("region", { name: "Effetti su Aldo" }));
    expect(effects.getByText("Benedizione")).toBeTruthy();
    expect(effects.getByText(/3 round, a fine turno/)).toBeTruthy();
    expect(effects.queryByRole("button")).toBeNull(); // sola lettura
    expect(document.body.textContent).not.toContain(SECRET_EFFECT);
    expect(within(dialog).queryByLabelText("Fazione")).toBeNull();
  });
});

describe("avvisi del combattimento", () => {
  it("un toast leggero per turno ed effetto, senza doppioni dopo la riconnessione", async () => {
    mount(gm);
    await screen.findByRole("tab", { name: "Iniziativa" });
    const turn = { type: "combat.turn", sceneId: "s1", round: 3, participantId: "p1", tokenId: "pg-luca" };
    delta([turn]);
    const toasts = within(await screen.findByRole("region", { name: "Notifiche" }));
    expect(await toasts.findByText("Tocca a Aldo")).toBeTruthy();
    // Lo stesso avviso (riconsegnato) non si ripete; un altro round si'.
    delta([turn]);
    expect(toasts.getAllByText("Tocca a Aldo")).toHaveLength(1);
    delta([{ ...turn, round: 4 }]);
    expect(toasts.getAllByText("Tocca a Aldo").length).toBeGreaterThan(0);
    delta([{ type: "effect.expiring", sceneId: "s1", round: 4, tokenId: "gob1", effectId: "ef-f", name: "Fiamma", remaining: 1 }]);
    expect(await toasts.findByText("«Fiamma» sta per finire")).toBeTruthy();
    delta([{ type: "effect.expired", sceneId: "s1", round: 5, tokenId: "gob1", effectId: "ef-f", name: "Fiamma", reason: "elapsed" }]);
    expect(await toasts.findByText("«Fiamma» è finito")).toBeTruthy();
    // Niente popup bloccanti.
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
