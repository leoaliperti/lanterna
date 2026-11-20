import { describe, expect, it } from "vitest";
import {
  MAX_CHAT_TEXT_LENGTH,
  MAX_HISTORY_PAGE,
  ServerMessageSchema,
  canSeeEntry,
  parseClientMessage,
  sanitizeChatText,
  sanitizeLabel,
} from "../index.js";

describe("schemi di chat e tiri", () => {
  it("rifiuta campi del vecchio segnaposto, esiti dal client e valori fuori limite", () => {
    for (const m of [
      { type: "chat.send", requestId: "r", text: "" },
      { type: "chat.send", requestId: "r", text: "x".repeat(MAX_CHAT_TEXT_LENGTH + 1) },
      { type: "chat.send", requestId: "r", text: "ciao", whisperTo: ["gm"] },
      { type: "roll.request", requestId: "r", formula: "2d6", secret: true },
      { type: "roll.request", requestId: "r", formula: "2d6" },
      { type: "roll.request", requestId: "r", formula: "2d6", visibility: "tutti" },
      { type: "roll.request", requestId: "r", formula: "2d6", visibility: "public", total: 12 },
      { type: "roll.request", requestId: "r", formula: "2d6", visibility: "public", result: [6, 6] },
      { type: "history.request", requestId: "r", before: null, limit: MAX_HISTORY_PAGE + 1 },
      { type: "history.request", requestId: "r" },
    ]) {
      const r = parseClientMessage(JSON.stringify(m));
      expect(r.ok, JSON.stringify(m)).toBe(false);
      if (!r.ok) expect(r.error).toMatchObject({ code: "INVALID", requestId: "r" });
    }
  });

  it("valida i messaggi del server (roll.result con dettaglio, history, errori)", () => {
    const entry = {
      kind: "roll",
      id: "e1",
      authorId: "u1",
      authorName: "Ana",
      at: 1,
      visibility: "public",
      whisperTo: null,
      label: null,
      formula: "2d6+3",
      advantage: "normal",
      terms: [
        {
          kind: "dice",
          sign: 1,
          count: 2,
          sides: 6,
          dice: [
            { face: 6, value: 4, kept: true },
            { face: 6, value: 5, kept: true },
          ],
          signedValue: 9,
        },
        { kind: "constant", sign: 1, value: 3, signedValue: 3 },
      ],
      total: 12,
      detail: "2d6+3 → [4, 5] + 3 = 12",
      critical: false,
      criticalFailure: false,
    };
    expect(ServerMessageSchema.safeParse({ type: "roll.result", requestId: null, entry }).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ type: "history", requestId: "r", entries: [entry], hasMore: false }).success).toBe(
      true,
    );
    expect(
      ServerMessageSchema.safeParse({ type: "error", requestId: "r", code: "INVALID", message: "x", reason: "TROPPI_DADI" })
        .success,
    ).toBe(true);
    expect(ServerMessageSchema.safeParse({ type: "error", requestId: "r", code: "RATE_LIMITED", message: "x" }).success).toBe(
      true,
    );
  });
});

describe("canSeeEntry", () => {
  const gm = { userId: "gm", role: "admin" as const };
  const gm2 = { userId: "gm2", role: "admin" as const };
  const p1 = { userId: "p1", role: "player" as const };
  const p2 = { userId: "p2", role: "player" as const };
  it("pubblico a tutti, gm solo ai GM, whisper solo ad autore e destinatario", () => {
    const pub = { visibility: "public" as const, authorId: "p1", whisperTo: null };
    const secret = { visibility: "gm" as const, authorId: "gm", whisperTo: null };
    const whisper = { visibility: "whisper" as const, authorId: "p1", whisperTo: "gm" };
    expect([gm, gm2, p1, p2].map((v) => canSeeEntry(pub, v))).toEqual([true, true, true, true]);
    expect([gm, gm2, p1, p2].map((v) => canSeeEntry(secret, v))).toEqual([true, true, false, false]);
    // Il GM non vede i whisper altrui (nemmeno un secondo GM).
    expect([gm, gm2, p1, p2].map((v) => canSeeEntry(whisper, v))).toEqual([true, false, true, false]);
  });
});

describe("sanitizeChatText", () => {
  it("lascia l'HTML come testo semplice (nessun escaping, nessuna interpretazione)", () => {
    expect(sanitizeChatText("<b>ciao</b> <script>x()</script> a < b && c > d")).toBe(
      "<b>ciao</b> <script>x()</script> a < b && c > d",
    );
  });
  it("toglie controlli, override bidirezionali, BOM e surrogati isolati; normalizza gli a capo", () => {
    expect(sanitizeChatText("  a\u0000b\u0007c\u202Ed\u2066e\uFEFF\u200Bf\u0085  ")).toBe("abcdef");
    expect(sanitizeChatText("x\ud800y\udc00z")).toBe("xyz");
    expect(sanitizeChatText("a\r\nb\rc\n\n\n\n\nd   \ne")).toBe("a\nb\nc\n\nd\ne");
    expect(sanitizeChatText("👨\u200D👩\u200D👧")).toBe("👨\u200D👩\u200D👧");
    expect(sanitizeChatText("e\u0301")).toBe("é");
    expect(sanitizeChatText(" \u0000\n\t ")).toBe("");
  });
  it("etichette su una riga", () => {
    expect(sanitizeLabel(" Attacco\n\ncon\tspada ")).toBe("Attacco con spada");
  });
});
