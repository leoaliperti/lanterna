import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { parseSheetDoc, snapshotOf, type SheetDoc, type SheetKind, type SheetRecord, type SheetSummary } from "@lanterna/shared";
import type { Db } from "../db/client.js";
import { campaignMember, characterSheet } from "../db/schema.js";

type Row = typeof characterSheet.$inferSelect;

/** Chi chiede: il GM vede tutto, il giocatore solo le proprie schede `pc`. */
export interface Viewer {
  userId: string;
  isGm: boolean;
}

/** Il documento in database viene validato a ogni lettura: se è corrotto la lettura fallisce (500), non passa. */
function readDoc(row: Row): SheetDoc {
  return parseSheetDoc(JSON.parse(row.data));
}

function summaryOf(row: Row, doc: SheetDoc, viewer: Viewer): SheetSummary {
  const s: SheetSummary = {
    id: row.id,
    campaignId: row.campaignId,
    kind: row.kind,
    name: row.name,
    ownerUserId: row.ownerUserId,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
    ...snapshotOf(doc),
  };
  // Il legame con il token (che potrebbe essere nascosto) lo conosce solo il GM.
  if (viewer.isGm) s.tokenId = row.tokenId;
  return s;
}

export function recordOf(row: Row, viewer: Viewer): SheetRecord {
  const doc = readDoc(row);
  return { ...summaryOf(row, doc, viewer), doc };
}

/** Condizione di visibilità: il giocatore vede solo le proprie schede di personaggio. */
export function canView(row: Row, viewer: Viewer): boolean {
  return viewer.isGm || (row.kind === "pc" && row.ownerUserId === viewer.userId);
}

export async function isMember(db: Db, campaignId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: campaignMember.userId })
    .from(campaignMember)
    .where(and(eq(campaignMember.campaignId, campaignId), eq(campaignMember.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

export async function listSheets(db: Db, campaignId: string, viewer: Viewer): Promise<SheetSummary[]> {
  const rows = await db
    .select()
    .from(characterSheet)
    .where(
      viewer.isGm
        ? eq(characterSheet.campaignId, campaignId)
        : and(
            eq(characterSheet.campaignId, campaignId),
            eq(characterSheet.kind, "pc"),
            eq(characterSheet.ownerUserId, viewer.userId),
          ),
    )
    .orderBy(asc(characterSheet.createdAt), asc(characterSheet.id));
  return rows.map((r) => summaryOf(r, readDoc(r), viewer));
}

export async function getRow(db: Db, campaignId: string, sheetId: string): Promise<Row | null> {
  const rows = await db
    .select()
    .from(characterSheet)
    .where(and(eq(characterSheet.campaignId, campaignId), eq(characterSheet.id, sheetId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function countOwned(db: Db, campaignId: string, userId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(characterSheet)
    .where(and(eq(characterSheet.campaignId, campaignId), eq(characterSheet.ownerUserId, userId)));
  return Number(rows[0]?.n ?? 0);
}

export async function tokenLinkedTo(db: Db, campaignId: string, tokenId: string): Promise<string | null> {
  const rows = await db
    .select({ id: characterSheet.id })
    .from(characterSheet)
    .where(and(eq(characterSheet.campaignId, campaignId), eq(characterSheet.tokenId, tokenId)))
    .limit(1);
  return rows[0]?.id ?? null;
}

export interface NewSheet {
  campaignId: string;
  kind: SheetKind;
  doc: SheetDoc;
  ownerUserId: string | null;
  tokenId: string | null;
}

export async function insertSheet(db: Db, s: NewSheet): Promise<Row> {
  const id = randomUUID();
  await db.insert(characterSheet).values({
    id,
    campaignId: s.campaignId,
    kind: s.kind,
    ownerUserId: s.ownerUserId,
    tokenId: s.tokenId,
    name: s.doc.sheet.name,
    data: JSON.stringify(s.doc),
  });
  return (await getRow(db, s.campaignId, id))!;
}

export interface SheetPatch {
  doc?: SheetDoc;
  ownerUserId?: string | null;
  tokenId?: string | null;
}

/** Aggiornamento condizionato alla versione letta: `null` se nel frattempo è cambiata (CONFLICT). */
export async function updateSheet(
  db: Db,
  campaignId: string,
  sheetId: string,
  expectedVersion: number,
  patch: SheetPatch,
): Promise<Row | null> {
  const updated = await db
    .update(characterSheet)
    .set({
      ...(patch.doc ? { data: JSON.stringify(patch.doc), name: patch.doc.sheet.name } : {}),
      ...(patch.ownerUserId !== undefined ? { ownerUserId: patch.ownerUserId } : {}),
      ...(patch.tokenId !== undefined ? { tokenId: patch.tokenId } : {}),
      version: expectedVersion + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(characterSheet.campaignId, campaignId),
        eq(characterSheet.id, sheetId),
        eq(characterSheet.version, expectedVersion),
      ),
    )
    .returning({ id: characterSheet.id });
  if (updated.length === 0) return null;
  return getRow(db, campaignId, sheetId);
}

export async function deleteSheet(db: Db, campaignId: string, sheetId: string): Promise<boolean> {
  const gone = await db
    .delete(characterSheet)
    .where(and(eq(characterSheet.campaignId, campaignId), eq(characterSheet.id, sheetId)))
    .returning({ id: characterSheet.id });
  return gone.length > 0;
}
