import { and, asc, desc, eq, lt, or, sql, type SQL } from "drizzle-orm";
import { LogEntrySchema, canSeeEntry, type ChatLogEntry, type Role } from "@lanterna/shared";
import type { Db } from "../db/client.js";
import { chatEntry } from "../db/schema.js";

/** Chi legge il log: `null` = tutto (solo per l'esportazione dell'admin). */
export type Viewer = { userId: string; role: Role } | null;

/** Salva una voce del log (prima di inviarla a chiunque). */
export async function insertEntry(db: Db, campaignId: string, entry: ChatLogEntry): Promise<void> {
  await db.insert(chatEntry).values({
    id: entry.id,
    campaignId,
    kind: entry.kind,
    authorId: entry.authorId,
    visibility: entry.visibility,
    whisperTo: entry.whisperTo,
    at: entry.at,
    data: JSON.stringify(entry),
  });
}

/** Stessa regola di `canSeeEntry`, in SQL (gli stessi test la verificano contro i dati reali). */
function visibleTo(viewer: Viewer): SQL | undefined {
  if (viewer === null) return undefined;
  const whisper = and(
    eq(chatEntry.visibility, "whisper"),
    or(eq(chatEntry.authorId, viewer.userId), eq(chatEntry.whisperTo, viewer.userId)),
  );
  return viewer.role === "admin"
    ? or(eq(chatEntry.visibility, "public"), eq(chatEntry.visibility, "gm"), whisper)
    : or(eq(chatEntry.visibility, "public"), whisper);
}

/**
 * Rilegge una riga validandola. Una riga non valida (database manomesso) viene scartata;
 * in più si ricontrolla la visibilità sul JSON: se colonne e JSON non concordano, non si invia.
 */
function parseRow(data: string, viewer: Viewer): ChatLogEntry | null {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const r = LogEntrySchema.safeParse(json);
  if (!r.success) return null;
  if (viewer && !canSeeEntry(r.data, viewer)) return null;
  return r.data;
}

export interface Page {
  entries: ChatLogEntry[];
  hasMore: boolean;
}

/**
 * Una pagina di cronologia visibile a `viewer`, in ordine cronologico: le `limit` voci più recenti
 * prima di `beforeId` (esclusa), o le ultime se `beforeId` è null. `null` se il cursore non esiste
 * o non è visibile a `viewer` (stessa risposta: non si rivela l'esistenza di voci altrui).
 */
export async function loadPage(
  db: Db,
  campaignId: string,
  viewer: NonNullable<Viewer>,
  beforeId: string | null,
  limit: number,
): Promise<Page | null> {
  const conditions: (SQL | undefined)[] = [eq(chatEntry.campaignId, campaignId), visibleTo(viewer)];
  if (beforeId !== null) {
    const cursor = await db
      .select({ seq: chatEntry.seq })
      .from(chatEntry)
      .where(and(eq(chatEntry.campaignId, campaignId), eq(chatEntry.id, beforeId), visibleTo(viewer)))
      .get();
    if (!cursor) return null;
    conditions.push(lt(chatEntry.seq, cursor.seq));
  }
  const rows = await db
    .select({ data: chatEntry.data })
    .from(chatEntry)
    .where(and(...conditions))
    .orderBy(desc(chatEntry.seq))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const entries = rows
    .slice(0, limit)
    .reverse()
    .map((r) => parseRow(r.data, viewer))
    .filter((e): e is ChatLogEntry => e !== null);
  return { entries, hasMore };
}

/** Tutto il log della campagna visibile a `viewer` (`null`: log completo), in ordine cronologico. */
export async function loadAll(db: Db, campaignId: string, viewer: Viewer, sinceMs?: number): Promise<ChatLogEntry[]> {
  const rows = await db
    .select({ data: chatEntry.data })
    .from(chatEntry)
    .where(
      and(
        eq(chatEntry.campaignId, campaignId),
        visibleTo(viewer),
        sinceMs === undefined ? undefined : sql`${chatEntry.at} >= ${sinceMs}`,
      ),
    )
    .orderBy(asc(chatEntry.seq));
  return rows.map((r) => parseRow(r.data, viewer)).filter((e): e is ChatLogEntry => e !== null);
}
