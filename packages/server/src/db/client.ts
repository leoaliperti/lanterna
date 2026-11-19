import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { schema } from "./schema.js";

export type Db = LibSQLDatabase<typeof schema>;

export interface Database {
  db: Db;
  client: Client;
  close(): void;
}

/** Cartella delle migrazioni generate da drizzle-kit (packages/server/drizzle). */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Apre il database SQLite (driver libSQL, nessuna compilazione nativa all'installazione),
 * attiva le chiavi esterne e applica le migrazioni mancanti.
 */
export async function openDatabase(url: string): Promise<Database> {
  if (url.startsWith("file:")) {
    const path = url.slice("file:".length);
    if (path && path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  }
  const client = createClient({ url });
  await client.execute("PRAGMA foreign_keys = ON");
  if (url.startsWith("file:")) await client.execute("PRAGMA journal_mode = WAL");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, client, close: () => client.close() };
}
