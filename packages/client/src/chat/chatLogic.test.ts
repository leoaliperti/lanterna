import { describe, expect, it } from "vitest";
import type { ChatLogEntry, Member } from "@lanterna/shared";
import { applyLatestHistory, applyLiveEntry, applyOlderHistory, mergeEntries } from "./chatLog";
import { matchRecipient, parseChatInput, whisperTargets } from "./commands";

const members: Member[] = [
  { userId: "gm", displayName: "Marta", role: "admin" },
  { userId: "luca", displayName: "Luca", role: "player" },
  { userId: "mr", displayName: "Mario Rossi", role: "player" },
  { userId: "mario", displayName: "Mario", role: "player" }
];

function msg(id: string, at: number, text = id): ChatLogEntry {
  return { kind: "message", id, authorId: "luca", authorName: "Luca", at, visibility: "public", whisperTo: null, text };
}

describe("cronologia: unione e deduplicazione", () => {
  it("unisce per id e ordina per istante, senza duplicati", () => {
    const merged = mergeEntries([msg("b", 2), msg("c", 3)], [msg("a", 1), msg("b", 2), msg("c", 3)]);
    expect(merged.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("a parita' di istante mantiene l'ordine di arrivo", () => {
    expect(mergeEntries([msg("x", 5)], [msg("y", 5), msg("z", 5)]).map((e) => e.id)).toEqual(["x", "y", "z"]);
  });

  it("dopo una riconnessione la cronologia dell'handshake non duplica le voci live", () => {
    let s = { entries: [msg("a", 1), msg("b", 2)] as readonly ChatLogEntry[], hasMore: false };
    s = applyLiveEntry(s, msg("c", 3));
    expect(applyLiveEntry(s, msg("c", 3))).toBe(s); // stessa voce: stesso stato
    s = applyLatestHistory(s, [msg("b", 2), msg("c", 3), msg("d", 4)], false);
    expect(s.entries.map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("le pagine piu' vecchie gia' caricate restano dopo la riconnessione, e hasMore resta quello noto", () => {
    let s = applyLatestHistory({ entries: [], hasMore: false }, [msg("c", 3), msg("d", 4)], true);
    s = applyOlderHistory(s, [msg("a", 1), msg("b", 2)], false);
    expect(s).toMatchObject({ hasMore: false });
    s = applyLatestHistory(s, [msg("c", 3), msg("d", 4)], true);
    expect(s.entries.map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
    expect(s.hasMore).toBe(false);
  });

  it("se nulla si sovrappone (si e' perso piu' di una pagina) la lista viene sostituita", () => {
    const s = applyLatestHistory({ entries: [msg("a", 1)], hasMore: false }, [msg("x", 10), msg("y", 11)], true);
    expect(s.entries.map((e) => e.id)).toEqual(["x", "y"]);
    expect(s.hasMore).toBe(true);
  });
});

describe("comandi testuali", () => {
  const luca = { userId: "luca", role: "player" as const };
  const gm = { userId: "gm", role: "admin" as const };

  it("/r invia una formula (e senza formula spiega l'uso)", () => {
    expect(parseChatInput("/r 2d6+3", { members, self: luca, recipient: null })).toEqual({ kind: "roll", formula: "2d6+3" });
    expect(parseChatInput("/r", { members, self: luca, recipient: null })).toMatchObject({ kind: "error" });
  });

  it("/w trova il destinatario anche con spazi nel nome e sceglie il nome piu' lungo", () => {
    expect(parseChatInput("/w Mario Rossi ci vediamo dopo", { members, self: gm, recipient: null })).toEqual({
      kind: "chat",
      text: "ci vediamo dopo",
      whisperTo: "mr"
    });
    expect(parseChatInput("/w mario ciao", { members, self: gm, recipient: null })).toEqual({ kind: "chat", text: "ciao", whisperTo: "mario" });
    expect(parseChatInput('/w "Mario Rossi" ciao', { members, self: gm, recipient: null })).toMatchObject({ whisperTo: "mr" });
  });

  it("/w con il solo nome di battesimo vale se è univoco", () => {
    const withSurname: Member[] = [...members, { userId: "gi", displayName: "Giulia Rossi", role: "player" }];
    expect(parseChatInput("/w giulia senti un rumore", { members: withSurname, self: gm, recipient: null })).toEqual({ kind: "chat", text: "senti un rumore", whisperTo: "gi" });
    // "Mario" è anche un nome intero: vince il nome esatto, non c'è ambiguità.
    expect(parseChatInput("/w mario ciao", { members: withSurname, self: gm, recipient: null })).toMatchObject({ whisperTo: "mario" });
    // Due persone con lo stesso nome di battesimo: niente ripiego, errore.
    const twins: Member[] = [...withSurname, { userId: "gi2", displayName: "Giulia Verdi", role: "player" }];
    expect(parseChatInput("/w giulia ciao", { members: twins, self: gm, recipient: null })).toMatchObject({ kind: "error" });
  });

  it("il giocatore puo' sussurrare solo al GM", () => {
    expect(parseChatInput("/w marta psst", { members, self: luca, recipient: null })).toEqual({ kind: "chat", text: "psst", whisperTo: "gm" });
    expect(parseChatInput("/w mario psst", { members, self: luca, recipient: null })).toEqual({ kind: "error", message: "Puoi sussurrare solo al GM." });
    expect(whisperTargets(members, luca).map((m) => m.userId)).toEqual(["gm"]);
    expect(whisperTargets(members, gm).map((m) => m.userId)).toEqual(["luca", "mr", "mario"]);
  });

  it("destinatario sconosciuto, testo mancante e comando sconosciuto sono errori locali, mai messaggi", () => {
    expect(parseChatInput("/w nessuno ciao", { members, self: gm, recipient: null })).toMatchObject({ kind: "error" });
    expect(parseChatInput("/w luca", { members, self: gm, recipient: null })).toMatchObject({ kind: "error" });
    expect(parseChatInput("/boh", { members, self: gm, recipient: null })).toMatchObject({ kind: "error" });
    expect(matchRecipient("luca", whisperTargets(members, gm))?.text).toBe("");
  });

  it("testo normale: pubblico, o sussurro se e' scelto un destinatario", () => {
    expect(parseChatInput("  ciao  ", { members, self: luca, recipient: null })).toEqual({ kind: "chat", text: "ciao" });
    expect(parseChatInput("ciao", { members, self: luca, recipient: "gm" })).toEqual({ kind: "chat", text: "ciao", whisperTo: "gm" });
  });
});
