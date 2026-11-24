/**
 * Colori di presenza: chi scrive in chat, traccia una freccia o pinga la mappa. Il GM ha sempre
 * lo stesso colore; ogni giocatore ne riceve uno stabile (derivato dal suo id) dalla stessa tavolozza.
 * Puro colore: nessun dato del giocatore esce da qui.
 */

/** Colore fisso del GM: non compare nella tavolozza dei giocatori. */
export const GM_COLOR = "#e03131";

/** Tavolozza dei giocatori: distinguibili fra loro e dal rosso del GM, leggibili su chiaro e scuro. */
export const PLAYER_PALETTE = ["#1971c2", "#2f9e44", "#9c36b5", "#f08c00", "#0c8599", "#c2255c", "#5f3dc4", "#66a80f"] as const;

/** Hash FNV-1a a 32 bit: stabile fra sessioni e dispositivi, senza dipendenze. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Colore di un giocatore (o del GM): stabile per `userId`. */
export function presenceColor(userId: string, isGm: boolean): string {
  if (isGm) return GM_COLOR;
  return PLAYER_PALETTE[hash(userId) % PLAYER_PALETTE.length]!;
}
