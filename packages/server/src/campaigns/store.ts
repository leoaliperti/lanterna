import { randomUUID } from "node:crypto";
import { and, asc, eq, lte, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";
import {
  CampaignStateSchema,
  IdSchema,
  SceneSchema,
  TokenSchema,
  checkInvariants,
  type CampaignState,
  type CampaignSummary,
  type LogEntry,
  type Member,
  type StateChange,
} from "@lanterna/shared";
import type { Db } from "../db/client.js";
import { campaign, campaignEvent, campaignMember, scene, token, user } from "../db/schema.js";

/**
 * Persistenza delle campagne su SQLite (Drizzle + libSQL).
 *
 * Schema (migrazione `0001_campaigns`):
 * - `campaign`: nome, `version`, `epoch`, scena attiva;
 * - `campaign_member`: (campagna, utente). Ruolo e nome visualizzato vengono dall'account
 *   (`user.role`, `user.name`): admin = GM;
 * - `scene` / `token`: una riga per oggetto con il JSON completo in `data`, validato con
 *   `SceneSchema` / `TokenSchema` a ogni lettura; `sort` conserva l'ordine (z-order dei token);
 * - `campaign_event`: registro dei cambiamenti per versione (ultimi `LOG_CAPACITY`), così un
 *   client può riprendere con un delta anche dopo un riavvio del server.
 *
 * Ogni comando accettato si salva con `persistChanges` in un'unica transazione (`db.batch`).
 */

export const LOG_CAPACITY = 500;

/** Lettura difensiva del registro: qualunque riga non valida invalida tutto il registro (=> snapshot). */
const StateChangeSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("token"),
    before: TokenSchema.nullable(),
    after: TokenSchema.nullable(),
    activeSceneId: IdSchema.nullable(),
  }),
  z.strictObject({
    type: z.literal("scene"),
    before: SceneSchema.nullable(),
    after: SceneSchema.nullable(),
    activeSceneId: IdSchema.nullable(),
  }),
  z.strictObject({
    type: z.literal("activeScene"),
    before: IdSchema.nullable(),
    after: IdSchema.nullable(),
    scene: SceneSchema.nullable(),
    tokens: z.array(TokenSchema),
  }),
]);
const StateChangesSchema = z.array(StateChangeSchema);

export class CampaignStoreError extends Error {}

export interface LoadedCampaign {
  state: CampaignState;
  epoch: string;
  log: LogEntry[];
}

/** Nome visualizzato valido per `NameSchema` (1-64 caratteri, senza spazi ai bordi). */
function displayName(name: string): string {
  const n = name.trim().slice(0, 64).trim();
  return n.length > 0 ? n : "?";
}

export async function loadMembers(db: Db, campaignId: string): Promise<Member[]> {
  const rows = await db
    .select({ userId: user.id, name: user.name, role: user.role })
    .from(campaignMember)
    .innerJoin(user, eq(user.id, campaignMember.userId))
    .where(eq(campaignMember.campaignId, campaignId))
    .orderBy(asc(campaignMember.createdAt), asc(user.id));
  return rows.map((r) => ({ userId: r.userId, displayName: displayName(r.name), role: r.role }));
}

export async function listCampaignIds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: campaign.id }).from(campaign).orderBy(asc(campaign.createdAt));
  return rows.map((r) => r.id);
}

/**
 * Carica una campagna completa. Lancia `CampaignStoreError` se i dati salvati non sono validi:
 * meglio non partire che perdere o inventare dati in silenzio.
 * I proprietari di token non più membri (utente eliminato) diventano `null` (`sanitized`).
 */
export async function loadCampaign(db: Db, id: string): Promise<(LoadedCampaign & { sanitized: boolean }) | null> {
  const row = await db.query.campaign.findFirst({ where: eq(campaign.id, id) });
  if (!row) return null;
  const members = await loadMembers(db, id);
  const memberIds = new Set(members.map((m) => m.userId));
  const sceneRows = await db.select().from(scene).where(eq(scene.campaignId, id)).orderBy(asc(scene.sort));
  const tokenRows = await db.select().from(token).where(eq(token.campaignId, id)).orderBy(asc(token.sort));

  const parse = <T>(schema: z.ZodType<T>, data: string, what: string): T => {
    const r = schema.safeParse(JSON.parse(data));
    if (!r.success) throw new CampaignStoreError(`${what} non valido nel database (campagna ${id})`);
    return r.data;
  };
  let sanitized = false;
  const tokens = tokenRows.map((r) => {
    const t = parse(TokenSchema, r.data, `token ${r.id}`);
    if (t.ownerUserId !== null && !memberIds.has(t.ownerUserId)) {
      sanitized = true;
      return { ...t, ownerUserId: null };
    }
    return t;
  });
  const state = CampaignStateSchema.safeParse({
    campaignId: row.id,
    name: row.name,
    version: row.version,
    activeSceneId: row.activeSceneId,
    members,
    scenes: sceneRows.map((r) => parse(SceneSchema, r.data, `scena ${r.id}`)),
    tokens,
  });
  if (!state.success) throw new CampaignStoreError(`stato non valido nel database (campagna ${id})`);
  const problems = checkInvariants(state.data);
  if (problems.length > 0) {
    throw new CampaignStoreError(`stato incoerente nel database (campagna ${id}): ${problems.join("; ")}`);
  }

  const eventRows = await db
    .select()
    .from(campaignEvent)
    .where(eq(campaignEvent.campaignId, id))
    .orderBy(asc(campaignEvent.version));
  let log: LogEntry[] = [];
  try {
    log = eventRows.map((r) => {
      const changes = StateChangesSchema.safeParse(JSON.parse(r.changes));
      if (!changes.success) throw new Error("registro non valido");
      return { version: r.version, changes: changes.data as StateChange[] };
    });
  } catch {
    log = [];
  }
  // Il registro serve solo se arriva esattamente alla versione attuale senza buchi.
  const contiguous = log.every((e, i) => i === 0 || log[i - 1]!.version + 1 === e.version);
  if (sanitized || !contiguous || (log.length > 0 && log[log.length - 1]!.version !== row.version)) log = [];
  return { state: state.data, epoch: row.epoch, log, sanitized };
}

export async function createCampaign(db: Db, name: string, createdBy: string): Promise<CampaignSummary> {
  const id = randomUUID();
  const now = new Date();
  await db.batch([
    db.insert(campaign).values({ id, name, version: 0, epoch: randomUUID(), createdBy, createdAt: now, updatedAt: now }),
    db.insert(campaignMember).values({ campaignId: id, userId: createdBy, createdAt: now }),
  ]);
  return { id, name, createdAt: now.toISOString() };
}

export async function listCampaigns(db: Db): Promise<CampaignSummary[]> {
  const rows = await db.select().from(campaign).orderBy(asc(campaign.createdAt));
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt.toISOString() }));
}

export async function listCampaignsOf(db: Db, userId: string): Promise<CampaignSummary[]> {
  const rows = await db
    .select({ id: campaign.id, name: campaign.name, createdAt: campaign.createdAt })
    .from(campaignMember)
    .innerJoin(campaign, eq(campaign.id, campaignMember.campaignId))
    .where(eq(campaignMember.userId, userId))
    .orderBy(asc(campaign.createdAt));
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt.toISOString() }));
}

export async function campaignExists(db: Db, id: string): Promise<boolean> {
  return (await db.query.campaign.findFirst({ where: eq(campaign.id, id), columns: { id: true } })) !== undefined;
}

/** Aggiunge un membro. `false` se lo era già. */
export async function addMember(db: Db, campaignId: string, userId: string): Promise<boolean> {
  const rows = await db
    .insert(campaignMember)
    .values({ campaignId, userId, createdAt: new Date() })
    .onConflictDoNothing()
    .returning({ userId: campaignMember.userId });
  return rows.length > 0;
}

/**
 * Rimuove un membro. Rifiuta (`last_admin`) se è l'ultimo admin della campagna:
 * il controllo è nella stessa istruzione SQL, quindi atomico.
 */
export async function removeMember(
  db: Db,
  campaignId: string,
  userId: string,
): Promise<"removed" | "not_found" | "last_admin"> {
  const anotherAdmin = sql`exists (
    select 1 from ${campaignMember} as m join ${user} as u on u.id = m.user_id
    where m.campaign_id = ${campaignId} and m.user_id <> ${userId} and u.role = 'admin')`;
  const notAdmin = sql`(select role from ${user} where id = ${userId}) <> 'admin'`;
  const rows = await db
    .delete(campaignMember)
    .where(
      and(
        eq(campaignMember.campaignId, campaignId),
        eq(campaignMember.userId, userId),
        sql`(${notAdmin} or ${anotherAdmin})`,
      ),
    )
    .returning({ userId: campaignMember.userId });
  if (rows.length > 0) return "removed";
  const exists = await db.query.campaignMember.findFirst({
    where: and(eq(campaignMember.campaignId, campaignId), eq(campaignMember.userId, userId)),
  });
  return exists ? "last_admin" : "not_found";
}

/** Campagne di cui l'utente è membro (per chiudere le connessioni o ricaricare i membri). */
export async function campaignIdsOf(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: campaignMember.campaignId })
    .from(campaignMember)
    .where(eq(campaignMember.userId, userId));
  return rows.map((r) => r.id);
}

const nextSort = (table: typeof scene | typeof token, campaignId: string): SQL =>
  sql`(select coalesce(max(${table.sort}), 0) + 1 from ${table} where ${table.campaignId} = ${campaignId})`;

/**
 * Salva in un'unica transazione i cambiamenti di un comando accettato:
 * versione, scena attiva, righe di scene e token toccate e voce del registro.
 */
export async function persistChanges(
  db: Db,
  next: CampaignState,
  changes: readonly StateChange[],
): Promise<void> {
  const id = next.campaignId;
  const ops: BatchItem<"sqlite">[] = [
    db
      .update(campaign)
      .set({ version: next.version, activeSceneId: next.activeSceneId, updatedAt: new Date() })
      .where(eq(campaign.id, id)),
  ];
  for (const c of changes) {
    if (c.type === "token") {
      if (c.after === null) {
        if (c.before) ops.push(db.delete(token).where(and(eq(token.campaignId, id), eq(token.id, c.before.id))));
      } else if (c.before === null) {
        ops.push(
          db
            .insert(token)
            .values({ campaignId: id, id: c.after.id, sceneId: c.after.sceneId, sort: nextSort(token, id), data: JSON.stringify(c.after) })
            .onConflictDoUpdate({
              target: [token.campaignId, token.id],
              set: { sceneId: c.after.sceneId, data: JSON.stringify(c.after) },
            }),
        );
      } else {
        ops.push(
          db
            .update(token)
            .set({ sceneId: c.after.sceneId, data: JSON.stringify(c.after) })
            .where(and(eq(token.campaignId, id), eq(token.id, c.after.id))),
        );
      }
    } else if (c.type === "scene") {
      if (c.after === null) {
        if (c.before) {
          ops.push(db.delete(token).where(and(eq(token.campaignId, id), eq(token.sceneId, c.before.id))));
          ops.push(db.delete(scene).where(and(eq(scene.campaignId, id), eq(scene.id, c.before.id))));
        }
      } else if (c.before === null) {
        ops.push(
          db
            .insert(scene)
            .values({ campaignId: id, id: c.after.id, sort: nextSort(scene, id), data: JSON.stringify(c.after) })
            .onConflictDoUpdate({ target: [scene.campaignId, scene.id], set: { data: JSON.stringify(c.after) } }),
        );
      } else {
        ops.push(
          db
            .update(scene)
            .set({ data: JSON.stringify(c.after) })
            .where(and(eq(scene.campaignId, id), eq(scene.id, c.after.id))),
        );
      }
    }
    // "activeScene": coperto dall'aggiornamento di `campaign`.
  }
  ops.push(
    db.insert(campaignEvent).values({ campaignId: id, version: next.version, changes: JSON.stringify(changes) }),
    db
      .delete(campaignEvent)
      .where(and(eq(campaignEvent.campaignId, id), lte(campaignEvent.version, next.version - LOG_CAPACITY))),
  );
  await db.batch(ops as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

/**
 * Riscrive lo stato fuori dai comandi (cambio dei membri): nuova epoca, registro svuotato,
 * proprietari dei token aggiornati. Ai client connessi si invia poi uno snapshot.
 */
export async function persistReset(db: Db, state: CampaignState, epoch: string, touchedTokenIds: string[]): Promise<void> {
  const id = state.campaignId;
  const touched = new Set(touchedTokenIds);
  const ops: BatchItem<"sqlite">[] = [
    db.update(campaign).set({ epoch, version: state.version, updatedAt: new Date() }).where(eq(campaign.id, id)),
    db.delete(campaignEvent).where(eq(campaignEvent.campaignId, id)),
  ];
  for (const t of state.tokens) {
    if (!touched.has(t.id)) continue;
    ops.push(db.update(token).set({ data: JSON.stringify(t) }).where(and(eq(token.campaignId, id), eq(token.id, t.id))));
  }
  await db.batch(ops as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

