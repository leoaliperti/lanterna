import type { ArchiveCounts, ArchiveMember, ImportOptions } from "@lanterna/shared";

/** Logica pura della schermata "Backup e importazione". */

export const NO_USER = "__none__";

/** Righe del riepilogo di un archivio, senza le voci a zero. */
export function summaryRows(counts: ArchiveCounts, includesChat: boolean): Array<{ label: string; value: number }> {
  const rows: Array<{ label: string; value: number }> = [
    { label: "Scene", value: counts.scenes },
    { label: "Token", value: counts.tokens },
    { label: "Muri e porte", value: counts.walls },
    { label: "Scene con nebbia", value: counts.fogs },
    { label: "Combattimenti", value: counts.combats },
    { label: "Gruppi di token", value: counts.groups },
    { label: "Schede personaggio e statblock", value: counts.sheets },
    { label: "Contenuti importati", value: counts.content },
    { label: "Elementi della libreria", value: counts.library },
    { label: "Immagini", value: counts.assets }
  ];
  if (includesChat) rows.push({ label: "Voci di chat e tiri", value: counts.chat });
  return rows.filter((r) => r.value > 0);
}

/** Opzioni da inviare: solo i giocatori associati compaiono nella mappatura. */
export function buildOptions(input: {
  name: string;
  archiveName: string;
  includeChat: boolean;
  members: readonly ArchiveMember[];
  mapping: Readonly<Record<string, string>>;
}): ImportOptions {
  const memberMap: Record<string, string | null> = {};
  for (const m of input.members) {
    if (m.role !== "player") continue;
    const chosen = input.mapping[m.ref];
    memberMap[m.ref] = chosen && chosen !== NO_USER ? chosen : null;
  }
  const name = input.name.trim();
  return { ...(name && name !== input.archiveName ? { name } : {}), memberMap, includeChat: input.includeChat };
}

/**
 * Proposta iniziale di associazione: un giocatore dell'archivio con lo stesso nome di un solo utente
 * (e quell'utente non gia' scelto) viene associato da solo. Resta modificabile.
 */
export function suggestMapping(members: readonly ArchiveMember[], users: ReadonlyArray<{ id: string; name: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const m of members) {
    if (m.role !== "player") continue;
    const same = users.filter((u) => u.name.trim().toLocaleLowerCase("it") === m.name.trim().toLocaleLowerCase("it"));
    if (same.length === 1 && !used.has(same[0]!.id)) {
      out[m.ref] = same[0]!.id;
      used.add(same[0]!.id);
    }
  }
  return out;
}

/** Utenti gia' scelti per un altro membro: il server rifiuta due membri sullo stesso utente. */
export function takenUsers(mapping: Readonly<Record<string, string>>, exceptRef: string): Set<string> {
  return new Set(Object.entries(mapping).filter(([ref, id]) => ref !== exceptRef && id !== NO_USER).map(([, id]) => id));
}
