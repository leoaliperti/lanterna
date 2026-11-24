import { randomUUID } from "node:crypto";
import { and, desc, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { gameLog } from "../db/schema.js";

/** Voci conservate per campagna: le più vecchie si tolgono a ogni nuova scrittura. */
export const GAME_LOG_KEEP = 2000;
export const GAME_LOG_PAGE = 50;

export interface GameLogEntry {
  id: string;
  /** Versione dello stato dopo il comando: serve come cursore per la pagina successiva. */
  version: number;
  at: string;
  actor: string;
  lines: string[];
}

/** Scrive una voce (solo se ci sono frasi) e toglie quelle oltre `GAME_LOG_KEEP`. */
export async function writeGameLog(db: Db, campaignId: string, version: number, actor: string, lines: readonly string[], at = new Date()): Promise<void> {
  if (lines.length === 0) return;
  await db.insert(gameLog).values({
    id: randomUUID(),
    campaignId,
    version,
    at: at.toISOString(),
    actor,
    lines: JSON.stringify(lines),
  });
  await db.delete(gameLog).where(and(eq(gameLog.campaignId, campaignId), lt(gameLog.version, version - GAME_LOG_KEEP)));
}

/** Pagina del registro, dalla più recente. `before`: solo le voci con versione minore (la pagina precedente). */
export async function listGameLog(db: Db, campaignId: string, before: number | null, limit = GAME_LOG_PAGE): Promise<GameLogEntry[]> {
  const rows = await db
    .select()
    .from(gameLog)
    .where(before === null ? eq(gameLog.campaignId, campaignId) : and(eq(gameLog.campaignId, campaignId), lt(gameLog.version, before)))
    .orderBy(desc(gameLog.version))
    .limit(limit);
  return rows.map((r) => ({ id: r.id, version: r.version, at: r.at, actor: r.actor, lines: JSON.parse(r.lines) as string[] }));
}
