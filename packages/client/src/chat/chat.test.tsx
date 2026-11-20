import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, viewFor, type Actor, type ChatLogEntry, type RollEntry } from "@lanterna/shared";
import type { SessionUser } from "../api/client";
import { FakeSocket } from "../realtime/fakeSocket";
import { RealtimeClient } from "../realtime/RealtimeClient";
import { RealtimeProvider } from "../realtime/RealtimeProvider";
import { SessionProvider } from "../session/SessionProvider";
import { resetSettingsCache, updateSettings } from "../settings/settings";
import { gm, luca, state } from "../table/testState";
import { Table } from "../table/Table";
import { ToastProvider } from "../ui";

const tray = vi.hoisted(() => ({
  rolls: [] as Array<Array<{ sides: number; value: number }>>,
  webgl: true,
  reduced: false
}));

vi.mock("../dice3d", async () => {
  const React = await import("react");
  return {
    DiceTray: ({ ref, onSettled }: { ref?: React.Ref<unknown>; onSettled?: (d: unknown) => void }) => {
      React.useImperativeHandle(ref, () => ({
        roll: async (dice: Array<{ sides: number; value: number }>) => {
          tray.rolls.push(dice);
          onSettled?.(dice);
        },
        clear: () => undefined
      }));
      return <div data-testid="dice-tray" />;
    }
  };
});
vi.mock("../dice3d/webgl", () => ({ isWebGLAvailable: () => tray.webgl, prefersReducedMotion: () => tray.reduced }));

let sockets: FakeSocket[] = [];
const cur = () => sockets[sockets.length - 1]!;

const users: Record<string, SessionUser> = {
  gm: { id: "gm", name: "Marta", email: "m@example.org", role: "admin" },
  luca: { id: "luca", name: "Luca", email: "l@example.org", role: "player" }
};

function mount(actor: Actor, history?: { entries: ChatLogEntry[]; hasMore?: boolean }) {
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
  connect(actor, history);
  return client;
}

function connect(actor: Actor, history?: { entries: ChatLogEntry[]; hasMore?: boolean }) {
  act(() => {
    cur().open();
    cur().push({ type: "snapshot", protocolVersion: PROTOCOL_VERSION, epoch: "e1", version: state.version, view: viewFor(state, actor) });
    cur().push({ type: "history", requestId: null, entries: history?.entries ?? [], hasMore: history?.hasMore ?? false });
  });
}

const base = { at: 1_700_000_000_000, visibility: "public" as const, whisperTo: null };
function msg(id: string, text: string, over: Partial<ChatLogEntry> = {}): ChatLogEntry {
  return { kind: "message", id, authorId: "sara", authorName: "Sara", text, ...base, ...over } as ChatLogEntry;
}
function rollEntry(id: string, over: Partial<RollEntry> = {}): RollEntry {
  return {
    kind: "roll",
    id,
    authorId: "sara",
    authorName: "Sara",
    ...base,
    label: null,
    formula: "2d6+3",
    advantage: "normal",
    terms: [
      { kind: "dice", sign: 1, count: 2, sides: 6, dice: [{ face: 6, value: 4, kept: true }, { face: 6, value: 5, kept: true }], signedValue: 9 },
      { kind: "constant", sign: 1, value: 3, signedValue: 3 }
    ],
    total: 12,
    detail: "2d6+3 → [4, 5] + 3 = 12",
    critical: false,
    criticalFailure: false,
    ...over
  };
}
const live = (entry: ChatLogEntry) => act(() => cur().push({ type: entry.kind === "roll" ? "roll.result" : "chat.message", requestId: null, entry }));

const sentOf = (type: string) => cur().sent.filter((m) => m.type === type) as Array<Record<string, unknown>>;
const openChat = async (u: ReturnType<typeof userEvent.setup>) => u.click(await screen.findByRole("tab", { name: /^Chat/ }));
const log = () => screen.getByRole("list", { name: "Messaggi e tiri" });

beforeEach(() => {
  sockets = [];
  tray.rolls = [];
  tray.webgl = true;
  tray.reduced = false;
  try {
    window.localStorage.clear();
  } catch {
    /* niente */
  }
  resetSettingsCache();
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chat: invio e cronologia", () => {
  it("invia un messaggio con Invio come testo semplice e svuota il campo alla conferma", async () => {
    const u = userEvent.setup();
    mount(luca);
    await openChat(u);
    await u.type(screen.getByRole("textbox", { name: "Messaggio" }), "ciao a tutti{Enter}");
    const sent = sentOf("chat.send");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ text: "ciao a tutti" });
    expect(sent[0]).not.toHaveProperty("whisperTo");
    act(() => cur().push({ type: "chat.message", requestId: sent[0]!.requestId, entry: msg("m1", "ciao a tutti", { authorId: "luca", authorName: "Luca" }) }));
    expect(await within(log()).findByText("ciao a tutti")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Messaggio" }) as HTMLInputElement).value).toBe("");
  });

  it("mostra il testo ostile come testo: nessun elemento HTML creato", async () => {
    const u = userEvent.setup();
    mount(luca);
    await openChat(u);
    const hostile = '<img src=x onerror="alert(1)"><script>window.hacked=1</script><b>grassetto</b>';
    live(msg("h1", hostile, { authorName: '<i onclick="x()">Sara</i>' }));
    live(rollEntry("h2", { label: "<img src=y onerror=alert(2)>" }));
    expect(within(log()).getByText(hostile)).toBeTruthy();
    expect(within(log()).getByText('<i onclick="x()">Sara</i>')).toBeTruthy();
    expect(within(log()).getByText("<img src=y onerror=alert(2)>")).toBeTruthy();
    expect(log().querySelector("img, script, b, i")).toBeNull();
    expect((window as unknown as { hacked?: number }).hacked).toBeUndefined();
  });

  it("cronologia dell'handshake, pagine piu' vecchie con cursore e deduplicazione dopo la riconnessione", async () => {
    const u = userEvent.setup();
    const client = mount(luca, { entries: [msg("b", "secondo"), msg("c", "terzo", { at: base.at + 10 })], hasMore: true });
    await openChat(u);
    expect(within(log()).getByText("secondo")).toBeTruthy();

    await u.click(screen.getByRole("button", { name: "Carica messaggi precedenti" }));
    const req = sentOf("history.request")[0]!;
    expect(req.before).toBe("b");
    act(() =>
      cur().push({ type: "history", requestId: req.requestId, entries: [msg("a", "primo", { at: base.at - 10 })], hasMore: false })
    );
    expect(screen.queryByRole("button", { name: "Carica messaggi precedenti" })).toBeNull();
    const texts = () => within(log()).getAllByText(/^(primo|secondo|terzo|quarto)$/).map((n) => n.textContent);
    expect(texts()).toEqual(["primo", "secondo", "terzo"]);

    // Voce live, poi caduta e riconnessione: la cronologia dell'handshake la contiene di nuovo.
    live(msg("d", "quarto", { at: base.at + 20 }));
    act(() => cur().drop());
    act(() => {
      client.retryNow();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });
    connect(luca, { entries: [msg("c", "terzo", { at: base.at + 10 }), msg("d", "quarto", { at: base.at + 20 })], hasMore: true });
    expect(texts()).toEqual(["primo", "secondo", "terzo", "quarto"]);
    // Lo stesso messaggio live ripetuto non compare due volte.
    live(msg("d", "quarto", { at: base.at + 20 }));
    expect(texts()).toEqual(["primo", "secondo", "terzo", "quarto"]);
  });

  it("indica con chiarezza i messaggi privati", async () => {
    const u = userEvent.setup();
    mount(luca);
    await openChat(u);
    live(msg("p1", "solo per te", { visibility: "whisper", whisperTo: "luca", authorId: "gm", authorName: "Marta" }));
    live(msg("p2", "pubblico"));
    const item = within(log()).getByText("solo per te").closest("li")!;
    expect(item.getAttribute("data-private")).toBe("true");
    expect(within(item).getByText("Sussurro da Marta")).toBeTruthy();
    expect(within(within(log()).getByText("pubblico").closest("li")!).queryByText(/Sussurro/)).toBeNull();
  });

  it("mostra il dettaglio del tiro dal server e segnala critico e fallimento critico", async () => {
    const u = userEvent.setup();
    mount(luca);
    await openChat(u);
    live(rollEntry("r1", { label: "Attacco" }));
    live(rollEntry("r2", { formula: "1d20", total: 20, detail: "1d20 → [20] = 20", critical: true }));
    live(rollEntry("r3", { formula: "1d20", total: 1, detail: "1d20 → [1] = 1", criticalFailure: true }));
    expect(within(log()).getByText("2d6+3 → [4, 5] + 3 = 12")).toBeTruthy();
    expect(within(log()).getByText("Attacco")).toBeTruthy();
    expect(within(log()).getByText("Critico")).toBeTruthy();
    expect(within(log()).getByText("Fallimento critico")).toBeTruthy();
  });
});

describe("chat: whisper", () => {
  it("il giocatore puo' sussurrare solo al GM: l'elenco non contiene gli altri giocatori", async () => {
    const u = userEvent.setup();
    mount(luca);
    await openChat(u);
    const select = screen.getByLabelText("Invia a") as HTMLSelectElement;
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Tutti", "Marta (GM)"]);
    await u.selectOptions(select, "gm");
    expect(screen.getByText(/Sussurro a Marta/)).toBeTruthy();
    await u.type(screen.getByRole("textbox", { name: "Messaggio" }), "psst{Enter}");
    expect(sentOf("chat.send")[0]).toMatchObject({ text: "psst", whisperTo: "gm" });
  });

  it("il GM puo' sussurrare a qualunque giocatore", async () => {
    const u = userEvent.setup();
    mount(gm);
    await openChat(u);
    const select = screen.getByLabelText("Invia a") as HTMLSelectElement;
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Tutti", "Luca", "Sara"]);
    await u.selectOptions(select, "sara");
    await u.type(screen.getByRole("textbox", { name: "Messaggio" }), "segreto{Enter}");
    expect(sentOf("chat.send")[0]).toMatchObject({ text: "segreto", whisperTo: "sara" });
  });

  it("comandi /r e /w dal campo di chat", async () => {
    const u = userEvent.setup();
    mount(luca);
    await openChat(u);
    const input = screen.getByRole("textbox", { name: "Messaggio" });
    await u.type(input, "/r 2d6+3{Enter}");
    expect(sentOf("roll.request")[0]).toMatchObject({ formula: "2d6+3", visibility: "public" });
    expect(sentOf("chat.send")).toHaveLength(0);
    act(() => cur().push({ type: "roll.result", requestId: sentOf("roll.request")[0]!.requestId, entry: rollEntry("r9", { authorId: "luca", authorName: "Luca" }) }));
    await u.clear(input);
    await u.type(input, "/w marta ci vediamo{Enter}");
    expect(sentOf("chat.send")[0]).toMatchObject({ text: "ci vediamo", whisperTo: "gm" });
    act(() =>
      cur().push({
        type: "chat.message",
        requestId: sentOf("chat.send")[0]!.requestId,
        entry: msg("w1", "ci vediamo", { authorId: "luca", authorName: "Luca", visibility: "whisper", whisperTo: "gm" })
      })
    );
    expect(await within(log()).findByText("Sussurro a Marta")).toBeTruthy();
    await u.clear(input);
    await u.type(input, "/w sara ciao{Enter}");
    expect(await screen.findByText("Puoi sussurrare solo al GM.")).toBeTruthy();
    expect(sentOf("chat.send")).toHaveLength(1);
  });
});

describe("dadi", () => {
  it("click su un dado invia solo la formula: nessun esito calcolato dal client", async () => {
    const u = userEvent.setup();
    mount(luca);
    await openChat(u);
    await u.click(screen.getByRole("button", { name: "Tira un d8" }));
    const req = sentOf("roll.request")[0]!;
    expect(req).toMatchObject({ formula: "1d8", visibility: "public" });
    expect(Object.keys(req).sort()).toEqual(["formula", "requestId", "type", "visibility"]);
  });

  it("vantaggio e svantaggio si applicano al d20, non agli altri dadi", async () => {
    const u = userEvent.setup();
    mount(luca);
    await openChat(u);
    await u.click(screen.getByRole("button", { name: "Opzioni del tiro" }));
    await u.click(screen.getByRole("radio", { name: "Vantaggio" }));
    await u.click(screen.getByRole("button", { name: /^Tira un d20/ }));
    await u.click(screen.getByRole("button", { name: "Tira un d6" }));
    expect(sentOf("roll.request").map((r) => r.formula)).toEqual(["1d20 adv", "1d6"]);
  });

  it("il giocatore non vede l'opzione solo-GM; il GM si', e il tiro parte con visibility gm", async () => {
    const u = userEvent.setup();
    mount(luca);
    await openChat(u);
    await u.click(screen.getByRole("button", { name: "Opzioni del tiro" }));
    expect(screen.getByRole("radio", { name: "Pubblico" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Sussurro" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Solo GM" })).toBeNull();
    cleanup();

    sockets = [];
    mount(gm);
    await openChat(u);
    await u.click(screen.getByRole("button", { name: "Opzioni del tiro" }));
    await u.click(screen.getByRole("radio", { name: "Solo GM" }));
    await u.type(screen.getByRole("textbox", { name: "Etichetta del tiro" }), "Percezione del goblin");
    await u.click(screen.getByRole("button", { name: "Tira un d20" }));
    expect(sentOf("roll.request")[0]).toMatchObject({ formula: "1d20", visibility: "gm", label: "Percezione del goblin" });
    expect(sentOf("roll.request")[0]).not.toHaveProperty("whisperTo");
  });

  it("tiro in whisper: il giocatore sussurra al GM, il GM deve scegliere il destinatario", async () => {
    const u = userEvent.setup();
    mount(luca);
    await openChat(u);
    await u.click(screen.getByRole("button", { name: "Opzioni del tiro" }));
    await u.click(screen.getByRole("radio", { name: "Sussurro" }));
    await u.click(screen.getByRole("button", { name: "Tira un d6" }));
    expect(sentOf("roll.request")[0]).toMatchObject({ visibility: "whisper", whisperTo: "gm" });
    cleanup();

    sockets = [];
    mount(gm);
    await openChat(u);
    await u.click(screen.getByRole("button", { name: "Opzioni del tiro" }));
    await u.click(screen.getByRole("radio", { name: "Sussurro" }));
    await u.click(screen.getByRole("button", { name: "Tira un d6" }));
    expect(sentOf("roll.request")).toHaveLength(0);
    expect(await screen.findByText("Scegli a chi sussurrare il tiro.")).toBeTruthy();
    await u.selectOptions(screen.getByLabelText("Sussurra il tiro a"), "luca");
    await u.click(screen.getByRole("button", { name: "Tira un d6" }));
    expect(sentOf("roll.request")[0]).toMatchObject({ visibility: "whisper", whisperTo: "luca" });
  });

  it("formula libera: l'errore del parser (italiano) compare accanto al campo", async () => {
    const u = userEvent.setup();
    mount(luca);
    await openChat(u);
    await u.type(screen.getByRole("textbox", { name: "Formula" }), "9999d9999");
    await u.click(screen.getByRole("button", { name: "Tira" }));
    const req = sentOf("roll.request")[0]!;
    expect(req.formula).toBe("9999d9999");
    act(() =>
      cur().push({
        type: "error",
        requestId: req.requestId,
        code: "INVALID",
        message: "Un gruppo di dadi può avere da 1 a 100 dadi con da 2 a 1000 facce.",
        reason: "DADI_FUORI_LIMITE"
      })
    );
    expect(await screen.findByText("Un gruppo di dadi può avere da 1 a 100 dadi con da 2 a 1000 facce.")).toBeTruthy();
  });
});

describe("overlay dei dadi 3D", () => {
  it("anima solo i valori del server ricevuti dal vivo, non quelli della cronologia", async () => {
    mount(luca, { entries: [rollEntry("old")] });
    expect(tray.rolls).toHaveLength(0);
    live(rollEntry("r1"));
    expect(await screen.findByTestId("dice-tray")).toBeTruthy();
    expect(tray.rolls).toEqual([
      [
        { sides: 6, value: 4 },
        { sides: 6, value: 5 }
      ]
    ]);
    expect(screen.getByTestId("dice-tray").closest(".a-dice-overlay")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("scompare da solo dopo qualche secondo", async () => {
    vi.useFakeTimers();
    mount(luca);
    live(rollEntry("r1"));
    expect(screen.queryByTestId("dice-tray")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByTestId("dice-tray")).toBeNull();
  });

  it("non compare se disattivata nelle Impostazioni, con movimento ridotto o senza WebGL", async () => {
    updateSettings({ dice3d: false });
    mount(luca);
    live(rollEntry("r1"));
    expect(screen.queryByTestId("dice-tray")).toBeNull();
    act(() => updateSettings({ dice3d: true }));
    tray.reduced = true;
    live(rollEntry("r2"));
    expect(screen.queryByTestId("dice-tray")).toBeNull();
    tray.reduced = false;
    live(rollEntry("r3"));
    expect(screen.queryByTestId("dice-tray")).not.toBeNull();
    expect(tray.rolls).toHaveLength(1);
    cleanup();

    tray.webgl = false;
    tray.rolls = [];
    sockets = [];
    mount(luca);
    live(rollEntry("r4"));
    expect(screen.queryByTestId("dice-tray")).toBeNull();
    expect(tray.rolls).toHaveLength(0);
  });

  it("l'interruttore nelle Impostazioni salva la preferenza", async () => {
    const u = userEvent.setup();
    mount(luca);
    await u.click(await screen.findByRole("button", { name: /Menu utente/ }));
    await u.click(await screen.findByRole("menuitem", { name: "Impostazioni" }));
    const toggle = await screen.findByRole("switch", { name: "Animazione 3D dei dadi" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await u.click(toggle);
    expect(JSON.parse(window.localStorage.getItem("lanterna.settings.v1")!)).toEqual({ dice3d: false, theme: "auto" });
  });
});

describe("badge, scorciatoie e accessibilita'", () => {
  it("segnala i nuovi messaggi con pannello su un'altra scheda e li azzera aprendo la chat", async () => {
    const u = userEvent.setup();
    mount(luca);
    live(msg("n1", "uno"));
    live(msg("n2", "due"));
    live(msg("mio", "mio", { authorId: "luca", authorName: "Luca" }));
    const tab = await screen.findByRole("tab", { name: /^Chat, 2 nuovi/ });
    expect(screen.getByRole("button", { name: /Mostra pannello|Nascondi pannello/ })).toBeTruthy();
    await u.click(tab);
    expect(screen.getByRole("tab", { name: "Chat" })).toBeTruthy();
    live(msg("n3", "tre"));
    expect(screen.getByRole("tab", { name: "Chat" })).toBeTruthy(); // visibile: nessun badge
  });

  it("annuncia in una regione live cortese solo l'ultima voce arrivata", async () => {
    mount(luca);
    live(msg("n1", "ciao"));
    live(rollEntry("r1", { critical: true, formula: "1d20", total: 20 }));
    const region = document.querySelector('[role="status"][aria-live="polite"][aria-atomic="true"]')!;
    expect(region.textContent).toBe("Sara ha tirato 1d20: 20. Critico!");
  });

  it("'/' porta il cursore nella chat anche dalla scheda Token; Esc esce dal campo", async () => {
    const u = userEvent.setup();
    mount(luca);
    await screen.findByRole("tab", { name: "Token" });
    fireEvent.keyDown(document.body, { key: "/" });
    const input = await screen.findByRole("textbox", { name: "Messaggio" });
    expect(document.activeElement).toBe(input);
    await u.keyboard("{Escape}");
    expect(document.activeElement).not.toBe(input);
    // Dentro un campo di testo '/' si scrive normalmente.
    await u.click(input);
    await u.keyboard("/r 1d4");
    expect((input as HTMLInputElement).value).toBe("/r 1d4");
  });

  it("Invio a focus sul tavolo apre la chat; su un pulsante non intercetta nulla", async () => {
    mount(luca);
    const map = document.getElementById("mappa")!;
    map.focus();
    fireEvent.keyDown(map, { key: "Enter" });
    expect(document.activeElement).toBe(await screen.findByRole("textbox", { name: "Messaggio" }));
    cleanup();
    sockets = [];
    mount(luca);
    const button = await screen.findByRole("tab", { name: "Token" });
    const spy = fireEvent.keyDown(button, { key: "Enter" });
    expect(spy).toBe(true);
    expect(screen.queryByRole("textbox", { name: "Messaggio" })).toBeNull();
  });
});
