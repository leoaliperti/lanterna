import type { TokenView } from "@lanterna/shared";
import type { CombatAlert } from "../realtime/RealtimeClient";
import type { ToastInput } from "../ui";

/**
 * Avvisi del combattimento (`combat.turn`, `effect.expiring`, `effect.expired`). Il server li manda solo ai
 * diretti interessati (GM e proprietario del token). Qui si decide come mostrarli senza disturbare: un toast
 * breve e un richiamo sul token, mai un popup da chiudere. Dopo una riconnessione lo stesso avviso puo'
 * arrivare di nuovo (il registro dei delta lo rimanda): `AlertDeduper` lo scarta, per round.
 */

/** Chiave stabile dell'avviso: stesso evento nello stesso round = stessa chiave. */
export function alertKey(a: CombatAlert): string {
  switch (a.type) {
    case "combat.turn":
      return `turn|${a.sceneId}|${a.round}|${a.participantId}`;
    case "effect.expiring":
      return `expiring|${a.sceneId}|${a.round}|${a.tokenId}|${a.effectId}`;
    case "effect.expired":
      return `expired|${a.sceneId}|${a.round}|${a.tokenId}|${a.effectId}|${a.reason}`;
  }
}

export class AlertDeduper {
  private seen = new Set<string>();
  constructor(private readonly max = 200) {}

  /** `true` la prima volta che si vede l'avviso, `false` se e' un doppione. */
  accept(alert: CombatAlert): boolean {
    const key = alertKey(alert);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > this.max) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  reset(): void {
    this.seen.clear();
  }
}

export interface AlertPresentation {
  toast: ToastInput;
  /** Token da evidenziare sulla mappa (se noto a questo utente). */
  pulse: { tokenId: string; kind: "turn" | "warn" | "expired" } | null;
}

/** Testo e richiamo di un avviso; `tokens` serve a leggere il nome (il giocatore vede solo quelli che gli arrivano). */
export function presentAlert(a: CombatAlert, tokens: readonly Pick<TokenView, "id" | "name">[], participantName?: string): AlertPresentation {
  const nameOf = (id: string | null) => (id ? tokens.find((t) => t.id === id)?.name : undefined);
  switch (a.type) {
    case "combat.turn": {
      const who = nameOf(a.tokenId) ?? participantName ?? "Il tuo turno";
      return {
        toast: { title: nameOf(a.tokenId) || participantName ? `Tocca a ${who}` : "Tocca a te", message: `Round ${a.round}`, tone: "info", duration: 3000 },
        pulse: a.tokenId ? { tokenId: a.tokenId, kind: "turn" } : null
      };
    }
    case "effect.expiring": {
      const who = nameOf(a.tokenId);
      return {
        toast: { title: `«${a.name}» sta per finire`, message: who ? `Su ${who}, ancora ${a.remaining} ${a.remaining === 1 ? "turno" : "turni"}` : undefined, tone: "warning", duration: 4000 },
        pulse: { tokenId: a.tokenId, kind: "warn" }
      };
    }
    case "effect.expired": {
      const who = nameOf(a.tokenId);
      return {
        toast: {
          title: `«${a.name}» è finito`,
          message: a.reason === "combatEnded" ? `${who ? `Su ${who}: ` : ""}il combattimento è terminato` : who ? `Su ${who}` : undefined,
          tone: "info",
          duration: 4000
        },
        pulse: { tokenId: a.tokenId, kind: "expired" }
      };
    }
  }
}
