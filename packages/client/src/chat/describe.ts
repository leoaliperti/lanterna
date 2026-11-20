import type { ChatLogEntry, Member } from "@lanterna/shared";

/** Etichetta della riservatezza di una voce (null se pubblica). Sempre testo: non solo colore. */
export function privacyLabel(entry: ChatLogEntry, selfId: string, members: readonly Member[]): string | null {
  if (entry.visibility === "public") return null;
  if (entry.visibility === "gm") return "Solo GM";
  const name = (id: string | null, fallback: string) => members.find((m) => m.userId === id)?.displayName ?? fallback;
  if (entry.authorId === selfId) return `Sussurro a ${name(entry.whisperTo, "un utente")}`;
  return `Sussurro da ${entry.authorName}`;
}

/** Frase breve per lo screen reader (regione live). */
export function announcement(entry: ChatLogEntry, selfId: string, members: readonly Member[]): string {
  const priv = privacyLabel(entry, selfId, members);
  if (entry.kind === "roll") {
    const what = entry.label ? `${entry.label}, ` : "";
    const crit = entry.critical ? " Critico!" : entry.criticalFailure ? " Fallimento critico." : "";
    return `${priv ? `${priv}. ` : ""}${entry.authorName} ha tirato ${what}${entry.formula}: ${entry.total}.${crit}`;
  }
  return `${priv ? `${priv}. ` : ""}${entry.authorName}: ${entry.text}`;
}

const timeFormat = (() => {
  try {
    return new Intl.DateTimeFormat("it-IT", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return null;
  }
})();

export function formatTime(at: number): string {
  const d = new Date(at);
  return timeFormat ? timeFormat.format(d) : d.toISOString().slice(11, 16);
}
