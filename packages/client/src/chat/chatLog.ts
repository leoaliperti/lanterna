import type { ChatLogEntry } from "@lanterna/shared";

/** Unisce voci nuove a quelle note, senza duplicati (per `id`), in ordine cronologico stabile. */
export function mergeEntries(existing: readonly ChatLogEntry[], incoming: readonly ChatLogEntry[]): ChatLogEntry[] {
  const seen = new Set<string>();
  const merged: ChatLogEntry[] = [];
  for (const e of [...existing, ...incoming]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    merged.push(e);
  }
  // Ordinamento stabile per istante del server: l'ordine di arrivo decide a parita' di `at`.
  return merged.map((e, i) => ({ e, i })).sort((a, b) => a.e.at - b.e.at || a.i - b.i).map((x) => x.e);
}

export interface LogState {
  entries: readonly ChatLogEntry[];
  /** Esistono voci piu' vecchie di quelle mostrate. */
  hasMore: boolean;
}

/**
 * Cronologia ricevuta dopo ogni `hello` (le ultime voci). La si unisce alla lista per `id`.
 * Se non si sovrappone a nulla di quanto gia' mostrato (si e' perso piu' di una pagina durante la
 * disconnessione) la lista viene sostituita, cosi' non resta un buco silenzioso.
 */
export function applyLatestHistory(state: LogState, incoming: readonly ChatLogEntry[], hasMore: boolean): LogState {
  if (state.entries.length === 0 || incoming.length === 0) return { entries: mergeEntries([], incoming), hasMore };
  const known = new Set(state.entries.map((e) => e.id));
  const overlaps = incoming.some((e) => known.has(e.id));
  if (!overlaps) return { entries: mergeEntries([], incoming), hasMore };
  // Le voci piu' vecchie gia' caricate restano: `hasMore` e' quello dell'ultima pagina richiesta.
  const oldest = incoming[0]!;
  const hasOlderLoaded = state.entries.some((e) => !incoming.some((i) => i.id === e.id) && e.at < oldest.at);
  return { entries: mergeEntries(state.entries, incoming), hasMore: hasOlderLoaded ? state.hasMore : hasMore };
}

/** Pagina piu' vecchia richiesta con `history.request`. */
export function applyOlderHistory(state: LogState, incoming: readonly ChatLogEntry[], hasMore: boolean): LogState {
  return { entries: mergeEntries(state.entries, incoming), hasMore };
}

/** Voce live (`chat.message` / `roll.result`). Restituisce lo stesso oggetto se era gia' nota. */
export function applyLiveEntry(state: LogState, entry: ChatLogEntry): LogState {
  if (state.entries.some((e) => e.id === entry.id)) return state;
  return { entries: mergeEntries(state.entries, [entry]), hasMore: state.hasMore };
}
