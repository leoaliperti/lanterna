import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, viewFor, type EphemeralAudience, type Shape } from "@lanterna/shared";
import type { MapCanvasHandle } from "../map";
import { FakeSocket } from "../realtime/fakeSocket";
import { RealtimeClient } from "../realtime/RealtimeClient";
import { RealtimeProvider } from "../realtime/RealtimeProvider";
import { gm, state } from "../table/testState";
import { ToastProvider, useToast } from "../ui";
import { useCombatFeed, type CombatFeed } from "./useCombatFeed";

/* Invio delle misure (private = niente al server) e arrivo delle forme degli altri. */

let socket: FakeSocket;
let feed: CombatFeed;
const clearMeasure = vi.fn();
const mapRef = { current: { clearMeasure } as unknown as MapCanvasHandle };

function Harness({ view }: { view: ReturnType<typeof viewFor> }) {
  feed = useCombatFeed({ view, sceneId: "s1", mapRef });
  const toast = useToast();
  return (
    <div>
      <p data-testid="count">{feed.shapes.length}</p>
      <button type="button" onClick={() => toast.show({ title: "Fatto", action: { label: "Annulla", onPress: () => clearMeasure("toast-action") } })}>
        toast
      </button>
    </div>
  );
}

function mount() {
  const client = new RealtimeClient({
    campaignId: "c1",
    url: "ws://test/api/ws",
    createSocket: (url) => (socket = new FakeSocket(url)),
    isOnline: () => true,
    commandTimeoutMs: 60_000
  });
  const view = viewFor(state, gm);
  render(
    <ToastProvider>
      <RealtimeProvider campaignId="c1" client={client}>
        <Harness view={view} />
      </RealtimeProvider>
    </ToastProvider>
  );
  act(() => {
    socket.open();
    socket.push({ type: "snapshot", protocolVersion: PROTOCOL_VERSION, epoch: "e1", version: state.version, view });
  });
}

const circle = (r: number): Shape => ({ kind: "circle", x: 200, y: 200, radius: r });
const shows = () => socket.sent.filter((m) => m.type === "ephemeral.show");

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(1_000_000);
  clearMeasure.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("misure: privata e pubblica", () => {
  it("una misura privata non invia nulla al server, nemmeno mentre si trascina", () => {
    mount();
    expect(feed.audience).toBe("private");
    act(() => {
      feed.onShape(circle(50), "draft");
      feed.onShape(circle(80), "end");
    });
    expect(shows()).toHaveLength(0);
    expect(socket.sent.some((m) => m.type === "ephemeral.clear")).toBe(false);
    // Un ping privato resta sul client, visibile qualche secondo.
    act(() => feed.onShape({ kind: "ping", x: 10, y: 10 }, "end"));
    expect(shows()).toHaveLength(0);
    expect(feed.shapes).toHaveLength(1);
  });

  it("una misura pubblica si invia con lo stesso id durante il trascinamento (a ritmo limitato) e al rilascio", () => {
    mount();
    act(() => feed.setAudience("all"));
    act(() => feed.onShape(circle(50), "draft"));
    act(() => feed.onShape(circle(60), "draft")); // troppo presto: saltata
    expect(shows()).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    act(() => feed.onShape(circle(70), "draft"));
    expect(shows()).toHaveLength(2);
    expect(shows()[0]!.id).toBe(shows()[1]!.id);
    act(() => feed.onShape(circle(90), "end"));
    const last = shows()[2]!;
    expect(last).toMatchObject({ audience: "all", sceneId: "s1", shape: circle(90), ttlMs: 10_000 });
    expect(last.id).toBe(shows()[0]!.id);
    // L'autore non riceve la propria forma dal server: la tiene qui e la mappa libera la bozza.
    expect(feed.shapes).toHaveLength(1);
    expect(clearMeasure).toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(10_100);
    });
    expect(screen.getByTestId("count").textContent).toBe("0");
  });

  it("annullare una misura pubblica in corso toglie la forma agli altri", () => {
    mount();
    act(() => feed.setAudience("gm"));
    act(() => feed.onShape(circle(50), "draft"));
    const id = shows()[0]!.id as string;
    act(() => feed.onShapeCancel());
    expect(socket.sent.at(-1)).toMatchObject({ type: "ephemeral.clear", id });
    act(() => feed.onShapeCancel()); // niente da togliere: nessun secondo messaggio
    expect(socket.sent.filter((m) => m.type === "ephemeral.clear")).toHaveLength(1);
  });

  it("freccia e ping pubblici hanno la scadenza predefinita del protocollo", () => {
    mount();
    act(() => feed.setAudience("all" as EphemeralAudience));
    act(() => feed.onShape({ kind: "ping", x: 5, y: 5 }, "end"));
    expect(shows()[0]).toMatchObject({ shape: { kind: "ping" }, ttlMs: 4000 });
    act(() => feed.onShape({ kind: "arrow", x1: 1, y1: 1, x2: 9, y2: 9 }, "end"));
    expect(shows()[1]).toMatchObject({ ttlMs: 6000 });
  });

  it("se il server rifiuta, la forma locale sparisce e compare un avviso", async () => {
    mount();
    act(() => feed.setAudience("all"));
    act(() => feed.onShape(circle(90), "end"));
    const req = shows()[0]!;
    expect(feed.shapes).toHaveLength(1);
    act(() => socket.push({ type: "error", requestId: req.requestId, code: "RATE_LIMITED", message: "troppi" }));
    expect(await screen.findByText("Troppo in fretta")).toBeTruthy();
    expect(feed.shapes).toHaveLength(0);
  });
});

describe("forme degli altri", () => {
  it("compaiono con la scadenza indicata dal server e si tolgono con ephemeral.cleared; le celle restano celle", () => {
    mount();
    act(() => socket.push({ type: "ephemeral.shown", id: "m1", authorId: "luca", sceneId: "s1", ttlMs: 3000, shape: { kind: "cells", cells: [1, 1, 2, 1] } }));
    expect(feed.shapes).toHaveLength(1);
    expect(feed.shapes[0]).toMatchObject({ shape: { kind: "cells", cells: [1, 1, 2, 1] }, ttlMs: 3000, expiresAt: 1_003_000 });
    // Un'altra scena non si mostra.
    act(() => socket.push({ type: "ephemeral.shown", id: "m2", authorId: "luca", sceneId: "s2", ttlMs: 3000, shape: { kind: "ping", x: 1, y: 1 } }));
    expect(feed.shapes).toHaveLength(1);
    act(() => socket.push({ type: "ephemeral.cleared", id: "m1", authorId: "luca" }));
    expect(feed.shapes).toHaveLength(0);
  });

  it("scadono da sole", () => {
    mount();
    act(() => socket.push({ type: "ephemeral.shown", id: "m1", authorId: "luca", sceneId: "s1", ttlMs: 1500, shape: { kind: "ping", x: 1, y: 1 } }));
    expect(screen.getByTestId("count").textContent).toBe("1");
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.getByTestId("count").textContent).toBe("0");
  });
});

describe("notifica con azione", () => {
  it("esegue l'azione e si chiude", async () => {
    mount();
    const u = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await u.click(screen.getByRole("button", { name: "toast" }));
    await u.click(await screen.findByRole("button", { name: "Annulla" }));
    expect(clearMeasure).toHaveBeenCalledWith("toast-action");
    expect(screen.queryByText("Fatto")).toBeNull();
  });
});
