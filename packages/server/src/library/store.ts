import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  LibraryContentSchema,
  type CreateLibraryItem,
  type LibraryContent,
  type LibraryItem,
  type LibraryItemPublic,
  type LibraryScope,
  type TokenKind,
  type UpdateLibraryItem,
} from "@lanterna/shared";
import type { Db } from "../db/client.js";
import { campaignMember, libraryItem } from "../db/schema.js";

type Row = typeof libraryItem.$inferSelect;

/** Chi legge: l'admin vede tutto, il giocatore solo i tipi consentiti delle campagne di cui è membro. */
export interface Viewer {
  userId: string;
  isAdmin: boolean;
}

function readContent(row: Row): LibraryContent {
  // Un dato non valido nel database blocca la lettura (500), non passa in silenzio.
  return LibraryContentSchema.parse(JSON.parse(row.data));
}

export function toItem(row: Row): LibraryItem {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    scope: row.campaignId === null ? "global" : "campaign",
    campaignId: row.campaignId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...readContent(row),
  };
}

/** Proiezione per i giocatori: lista bianca di campi, niente statistiche né id di campagna. */
export function toPublic(item: LibraryItem): LibraryItemPublic {
  return { id: item.id, name: item.name, kind: item.kind, scope: item.scope, size: item.size, imageUrl: item.imageUrl, tags: item.tags };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface ListQuery {
  /** Con `campaignId`: elementi di quella campagna e globali. Senza: solo i globali. */
  campaignId?: string;
  kind?: TokenKind;
  q?: string;
  limit: number;
  offset: number;
}

/** Condizione di visibilità per un giocatore: solo tipi consentiti, solo globali o di sue campagne. */
function playerVisibility(viewer: Viewer, kinds: readonly TokenKind[]): SQL {
  if (kinds.length === 0) return sql`0`;
  return and(
    inArray(libraryItem.kind, [...kinds]),
    or(
      isNull(libraryItem.campaignId),
      inArray(
        libraryItem.campaignId,
        sql`(SELECT ${campaignMember.campaignId} FROM ${campaignMember} WHERE ${campaignMember.userId} = ${viewer.userId})`,
      ),
    ),
  )!;
}

export async function listLibrary(
  db: Db,
  viewer: Viewer,
  playerKinds: readonly TokenKind[],
  query: ListQuery,
): Promise<{ items: LibraryItem[]; total: number }> {
  const conditions: (SQL | undefined)[] = [];
  if (!viewer.isAdmin) conditions.push(playerVisibility(viewer, playerKinds));
  conditions.push(
    query.campaignId
      ? or(isNull(libraryItem.campaignId), eq(libraryItem.campaignId, query.campaignId))
      : isNull(libraryItem.campaignId),
  );
  if (query.kind) conditions.push(eq(libraryItem.kind, query.kind));
  if (query.q) {
    const pattern = `%${escapeLike(query.q.toLowerCase())}%`;
    conditions.push(
      or(
        sql`lower(${libraryItem.name}) LIKE ${pattern} ESCAPE '\\'`,
        // I tag stanno nel JSON: la ricerca li trova senza una tabella a parte.
        sql`lower(json_extract(${libraryItem.data}, '$.tags')) LIKE ${pattern} ESCAPE '\\'`,
      ),
    );
  }
  const where = and(...conditions);
  const rows = await db
    .select()
    .from(libraryItem)
    .where(where)
    .orderBy(asc(libraryItem.name), asc(libraryItem.id))
    .limit(query.limit)
    .offset(query.offset);
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)` }).from(libraryItem).where(where);
  return { items: rows.map(toItem), total: Number(n) };
}

export async function getItem(db: Db, id: string): Promise<LibraryItem | null> {
  const [row] = await db.select().from(libraryItem).where(eq(libraryItem.id, id)).limit(1);
  return row ? toItem(row) : null;
}

export async function countInScope(db: Db, campaignId: string | null): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(libraryItem)
    .where(campaignId === null ? isNull(libraryItem.campaignId) : eq(libraryItem.campaignId, campaignId));
  return Number(row?.n ?? 0);
}

function contentOf(input: LibraryContent): LibraryContent {
  return { size: input.size, imageUrl: input.imageUrl, stats: input.stats, tags: input.tags };
}

export async function insertItem(db: Db, input: CreateLibraryItem): Promise<LibraryItem> {
  const id = randomUUID();
  const now = new Date();
  await db.insert(libraryItem).values({
    id,
    campaignId: input.scope === "campaign" ? (input.campaignId ?? null) : null,
    name: input.name,
    kind: input.kind,
    data: JSON.stringify(contentOf(input)),
    createdAt: now,
    updatedAt: now,
  });
  return (await getItem(db, id))!;
}

export async function updateItem(db: Db, id: string, patch: UpdateLibraryItem): Promise<LibraryItem | null> {
  const current = await getItem(db, id);
  if (!current) return null;
  const next: LibraryContent = {
    size: patch.size ?? current.size,
    imageUrl: patch.imageUrl !== undefined ? patch.imageUrl : current.imageUrl,
    stats: patch.stats ?? current.stats,
    tags: patch.tags ?? current.tags,
  };
  await db
    .update(libraryItem)
    .set({
      name: patch.name ?? current.name,
      kind: patch.kind ?? current.kind,
      data: JSON.stringify(next),
      updatedAt: new Date(),
    })
    .where(eq(libraryItem.id, id));
  return getItem(db, id);
}

export async function deleteItem(db: Db, id: string): Promise<boolean> {
  const gone = await db.delete(libraryItem).where(eq(libraryItem.id, id)).returning({ id: libraryItem.id });
  return gone.length > 0;
}

/** Elementi di una sola campagna (per l'esportazione), in ordine di creazione. */
export async function itemsOfCampaign(db: Db, campaignId: string): Promise<LibraryItem[]> {
  const rows = await db
    .select()
    .from(libraryItem)
    .where(eq(libraryItem.campaignId, campaignId))
    .orderBy(asc(libraryItem.createdAt), asc(libraryItem.id));
  return rows.map(toItem);
}

export type { LibraryScope };
