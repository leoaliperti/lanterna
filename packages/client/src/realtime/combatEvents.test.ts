import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, viewFor } from "@lanterna/shared";
import { gm, state } from "../table/testState";
import { FakeSocket } from "./fakeSocket";
import { RealtimeClient, type RealtimeEvent } from "./RealtimeClient";

function connected() {
  let socket!: FakeSocket;
  const client = new RealtimeClient({ campaignId: "c1", url: "ws://t/ws", createSocket: (u) => (socket = new FakeSocket(u)), isOnline: () => true, commandTimeoutMs: 60_000 });
  client.start();
  socket.open();
  socket.push({ type: "snapshot", protocolVersion: PROTOCOL_VERSION, epoch: "e1", version: state.version, view: viewFor(state, gm) });
  return { client, socket };
}

describe("RealtimeClient: avvisi del combattimento e messaggi del M7", () => {
  it("emette gli avvisi contenuti in un delta e non li confonde con altri eventi", () => {
    const { client, socket } = connected();
    const events: RealtimeEvent[] = [];
    client.onEvent((e) => events.push(e));
    const turn = { type: "combat.turn", sceneId: "s1", round: 1, participantId: "p1", tokenId: "pg-luca" };
    socket.push({ type: "delta", epoch: "e1", fromVersion: state.version, toVersion: state.version + 1, events: [turn, { type: "token.deleted", tokenId: "altra-scena" }] });
    expect(events).toEqual([{ type: "alert", alert: turn }]);
    expect(client.getState().view!.version).toBe(state.version + 1);
    // Un delta con un buco non emette nulla (si chiede lo snapshot).
    events.length = 0;
    socket.push({ type: "delta", epoch: "e1", fromVersion: 999, toVersion: 1000, events: [turn] });
    expect(events).toEqual([]);
  });

  it("invia ephemeral.show, ephemeral.clear e initiative.roll con requestId e senza esiti", async () => {
    const { client, socket } = connected();
    const show = client.showEphemeral({ id: "m1", sceneId: "s1", audience: "all", shape: { kind: "ping", x: 1, y: 2 }, color: "#ff0000", ttlMs: 2000 });
    const sent = socket.last("ephemeral.show") as Record<string, unknown>;
    expect(sent).toMatchObject({ id: "m1", sceneId: "s1", audience: "all", shape: { kind: "ping", x: 1, y: 2 }, color: "#ff0000", ttlMs: 2000 });
    socket.push({ type: "ack", requestId: sent.requestId, version: state.version });
    expect(await show).toEqual({ ok: true, version: state.version });

    void client.clearEphemeral("m1");
    expect(socket.last("ephemeral.clear")).toMatchObject({ id: "m1" });

    void client.rollInitiative({ sceneId: "s1", rolls: [{ participantId: "p1", bonus: 2, mode: "advantage" }], sort: true });
    const roll = socket.last("initiative.roll") as Record<string, unknown>;
    expect(roll).toMatchObject({ sceneId: "s1", sort: true, rolls: [{ participantId: "p1", bonus: 2, mode: "advantage" }] });
    expect(JSON.stringify(roll)).not.toMatch(/total|natural|dice/);
  });

  it("un rifiuto del server arriva al chiamante, offline non invia nulla", async () => {
    const { client, socket } = connected();
    const p = client.showEphemeral({ id: "m", sceneId: "s1", audience: "all", shape: { kind: "ping", x: 1, y: 1 } });
    const req = socket.last("ephemeral.show") as { requestId: string };
    socket.push({ type: "error", requestId: req.requestId, code: "RATE_LIMITED", message: "troppi messaggi" });
    expect(await p).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    socket.drop();
    const sendSpy = vi.spyOn(socket, "send");
    expect(await client.showEphemeral({ id: "m", sceneId: "s1", audience: "all", shape: { kind: "ping", x: 1, y: 1 } })).toMatchObject({ ok: false, code: "OFFLINE" });
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
