import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { campaign, campaignMember, content } from "../db/schema.js";
import { GM_ONLY_KINDS, type ContentKind, type ParsedContent } from "./schema.js";

export interface ContentSummary {
  id: string;
  kind: ContentKind;
  name: string;
  source: string;
  campaignId: string | null;
}

export interface ContentDoc extends ContentSummary {
  data: Record<string, unknown>;
}

export interface ImportResult {
  created: number;
  updated: number;
  total: number;
}

export class UnknownCampaignError extends Error {}

function keyOf(kind: string, name: string, source: string, campaignId: string | null): string {
  return createHash("sha256")
    .update([kind, name.toLowerCase(), source, campaignId ?? ""].join("\u0000"))
    .digest("hex");
}

/**
 * Importa i documenti in un'unica transazione (tutto o niente). Idempotente: lo stesso
 * (tipo, nome, fonte, campagna) viene aggiornato invece di duplicarsi.
 */
export async function importContent(db: Db, parsed: ParsedContent): Promise<ImportResult> {
  if (parsed.campaignId) {
    const found = await db.select({ id: campaign.id }).from(campaign).where(eq(campaign.id, parsed.campaignId)).limit(1);
    if (found.length === 0) throw new UnknownCampaignError(`Campagna inesistente: ${parsed.campaignId}`);
  }
  return db.transaction(async (tx) => {
    let created = 0;
    let updated = 0;
    // Duplicati nello stesso file: vince l'ultimo.
    const unique = new Map<string, ParsedContent["items"][number]>();
    for (const it of parsed.items) unique.set(keyOf(it.kind, it.name, it.source, parsed.campaignId), it);
    for (const [key, it] of unique) {
      const existing = await tx.select({ id: content.id }).from(content).where(eq(content.key, key)).limit(1);
      const data = JSON.stringify(it.data);
      if (existing[0]) {
        await tx
          .update(content)
          .set({ name: it.name, data, updatedAt: new Date() })
          .where(eq(content.id, existing[0].id));
        updated++;
      } else {
        await tx.insert(content).values({
          id: randomUUID(),
          key,
          kind: it.kind,
          name: it.name,
          data,
          source: it.source,
          campaignId: parsed.campaignId,
        });
        created++;
      }
    }
    return { created, updated, total: unique.size };
  });
}

export interface Viewer {
  userId: string;
  isAdmin: boolean;
}

/** Tipi che il giocatore può leggere: quelli configurati, tolti sempre i riservati al GM. */
export function playerKinds(configured: readonly string[]): ContentKind[] {
  return configured.filter(
    (k): k is ContentKind => !GM_ONLY_KINDS.includes(k as ContentKind) && ["item", "spell", "class", "species", "altro"].includes(k),
  );
}

/** Condizione SQL di visibilità: l'admin vede tutto; il giocatore solo tipi consentiti e campagne di cui è membro. */
function visibility(viewer: Viewer, kinds: ContentKind[]): SQL | undefined {
  if (viewer.isAdmin) return undefined;
  if (kinds.length === 0) return sql`0`;
  return and(
    inArray(content.kind, kinds),
    or(
      isNull(content.campaignId),
      inArray(
        content.campaignId,
        sql`(SELECT ${campaignMember.campaignId} FROM ${campaignMember} WHERE ${campaignMember.userId} = ${viewer.userId})`,
      ),
    ),
  );
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface ListQuery {
  kind?: ContentKind;
  q?: string;
  campaignId?: string;
  limit: number;
  offset: number;
}

export async function listContent(
  db: Db,
  viewer: Viewer,
  kinds: ContentKind[],
  query: ListQuery,
): Promise<{ items: ContentSummary[]; total: number }> {
  const conditions: (SQL | undefined)[] = [visibility(viewer, kinds)];
  if (query.kind) conditions.push(eq(content.kind, query.kind));
  if (query.campaignId) conditions.push(eq(content.campaignId, query.campaignId));
  if (query.q) {
    const pattern = `%${escapeLike(query.q.toLowerCase())}%`;
    conditions.push(
      or(
        sql`lower(${content.name}) LIKE ${pattern} ESCAPE '\\'`,
        sql`lower(${content.data}) LIKE ${pattern} ESCAPE '\\'`,
      ),
    );
  }
  const where = and(...conditions);
  const rows = await db
    .select({
      id: content.id,
      kind: content.kind,
      name: content.name,
      source: content.source,
      campaignId: content.campaignId,
    })
    .from(content)
    .where(where)
    .orderBy(asc(content.name), asc(content.id))
    .limit(query.limit)
    .offset(query.offset);
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)` }).from(content).where(where);
  return { items: rows, total: Number(n) };
}

export async function getContent(db: Db, viewer: Viewer, kinds: ContentKind[], id: string): Promise<ContentDoc | null> {
  const [row] = await db
    .select()
    .from(content)
    .where(and(eq(content.id, id), visibility(viewer, kinds)))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    source: row.source,
    campaignId: row.campaignId,
    data: JSON.parse(row.data) as Record<string, unknown>,
  };
}

export async function deleteContent(db: Db, id: string): Promise<boolean> {
  const deleted = await db.delete(content).where(eq(content.id, id)).returning({ id: content.id });
  return deleted.length > 0;
}
