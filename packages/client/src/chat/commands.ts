import type { Member } from "@lanterna/shared";

export type Role = "admin" | "player";

/** Chi puo' ricevere un whisper da questo utente (il giocatore solo i GM, il GM chiunque; mai se stessi). */
export function whisperTargets(members: readonly Member[], self: { userId: string; role: Role }): Member[] {
  return members.filter((m) => m.userId !== self.userId && (self.role === "admin" || m.role === "admin"));
}

export type ParsedInput =
  | { kind: "chat"; text: string; whisperTo?: string }
  | { kind: "roll"; formula: string }
  | { kind: "error"; message: string };

const norm = (s: string) => s.normalize("NFC").toLocaleLowerCase("it-IT");

/** Cerca all'inizio di `rest` il nome di uno dei destinatari (il piu' lungo vince: i nomi possono avere spazi). */
export function matchRecipient(rest: string, targets: readonly Member[]): { member: Member; text: string } | null {
  const lower = norm(rest);
  const quoted = /^"([^"]+)"\s*(.*)$/s.exec(rest);
  if (quoted) {
    const m = targets.find((t) => norm(t.displayName) === norm(quoted[1]!.trim()));
    return m ? { member: m, text: quoted[2]!.trim() } : null;
  }
  const sorted = [...targets].sort((a, b) => b.displayName.length - a.displayName.length);
  for (const m of sorted) {
    const name = norm(m.displayName);
    if (lower === name) return { member: m, text: "" };
    if (lower.startsWith(name) && /\s/.test(lower.charAt(name.length))) return { member: m, text: rest.slice(name.length).trim() };
  }
  return null;
}

/**
 * Interpreta il testo del campo di chat.
 * - `/r <formula>`: tiro (visibilita' decisa dal pannello dei dadi);
 * - `/w <nome> <testo>` (o `/w "nome con spazi" testo`): whisper;
 * - altro che inizia con `/`: errore (non si spedisce come messaggio per sbaglio);
 * - il resto: messaggio, al destinatario scelto se c'e'.
 */
export function parseChatInput(
  raw: string,
  ctx: { members: readonly Member[]; self: { userId: string; role: Role }; recipient: string | null }
): ParsedInput {
  const text = raw.trim();
  if (!text) return { kind: "error", message: "Scrivi un messaggio." };
  if (!text.startsWith("/")) return { kind: "chat", text, ...(ctx.recipient ? { whisperTo: ctx.recipient } : {}) };

  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const cmd = (m?.[1] ?? "").toLowerCase();
  const rest = (m?.[2] ?? "").trim();

  if (cmd === "r" || cmd === "roll") {
    return rest ? { kind: "roll", formula: rest } : { kind: "error", message: "Scrivi la formula, per esempio /r 2d6+3." };
  }
  if (cmd === "w" || cmd === "whisper") {
    const targets = whisperTargets(ctx.members, ctx.self);
    if (!rest) return { kind: "error", message: "Uso: /w nome testo." };
    const hit = matchRecipient(rest, targets);
    if (!hit) {
      const others = ctx.members.filter((x) => x.userId !== ctx.self.userId);
      const known = others.some((x) => norm(rest).startsWith(norm(x.displayName)));
      return {
        kind: "error",
        message: known && ctx.self.role === "player" ? "Puoi sussurrare solo al GM." : "Non trovo questo destinatario. Controlla il nome."
      };
    }
    if (!hit.text) return { kind: "error", message: "Scrivi anche il testo del messaggio." };
    return { kind: "chat", text: hit.text, whisperTo: hit.member.userId };
  }
  return { kind: "error", message: `Comando sconosciuto: /${cmd}. Usa /r per i tiri e /w per i sussurri.` };
}
