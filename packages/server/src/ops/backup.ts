import { createReadStream, existsSync } from "node:fs";
import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createClient } from "@libsql/client";

/** Nome del file SQLite dentro una cartella di backup. */
export const BACKUP_DB_NAME = "lanterna.db";
/** Nome della cartella dei file caricati dentro una cartella di backup. */
export const BACKUP_UPLOADS_NAME = "uploads";
/** Cartelle di backup riconosciute (e quindi ruotabili): `lanterna-AAAAMMGG-OOMMSS[-n]`. */
const BACKUP_DIR = /^lanterna-\d{8}-\d{6}(-\d+)?$/;
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");

export class OpsError extends Error {}

export interface BackupOptions {
  /** Percorso del file SQLite (non l'URL `file:`). */
  dbPath: string;
  uploadDir: string;
  backupDir: string;
  /** Quante copie tenere (le più recenti). */
  keep: number;
  now?: Date;
}

export interface BackupResult {
  dir: string;
  dbFile: string;
  uploadsCopied: boolean;
  removed: string[];
}

/** `file:./x.db` (o `file:/abs/x.db`) → percorso assoluto. */
export function dbPathFromUrl(url: string): string {
  if (!url.startsWith("file:")) throw new OpsError("Backup e ripristino funzionano solo con un database SQLite su file (file:...).");
  const path = url.slice("file:".length).replace(/^\/\//, "");
  if (!path || path.includes(":memory:")) throw new OpsError("Il database in memoria non si può salvare.");
  return resolve(path);
}

function stamp(d: Date): string {
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-` + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/** Il file inizia con l'intestazione di SQLite? (rifiuta testo, immagini, file troncati) */
export async function hasSqliteHeader(path: string): Promise<boolean> {
  return new Promise((ok) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(path, { start: 0, end: SQLITE_MAGIC.length - 1 });
    stream.on("data", (c) => chunks.push(c as Buffer));
    stream.on("error", () => ok(false));
    stream.on("end", () => ok(Buffer.concat(chunks).equals(SQLITE_MAGIC)));
  });
}

/** Controlla intestazione + `PRAGMA integrity_check` + presenza della tabella `user`. */
export async function verifySqlite(path: string): Promise<void> {
  if (!existsSync(path)) throw new OpsError(`File non trovato: ${path}`);
  if (!(await hasSqliteHeader(path))) throw new OpsError(`${path} non è un database SQLite.`);
  const client = createClient({ url: `file:${path}`, intMode: "number" });
  try {
    const check = await client.execute("PRAGMA integrity_check");
    if (String(check.rows[0]?.[0]) !== "ok") throw new OpsError(`${path}: controllo di integrità fallito.`);
    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'");
    if (tables.rows.length === 0) throw new OpsError(`${path} è un SQLite ma non sembra un database di Lanterna.`);
  } catch (err) {
    if (err instanceof OpsError) throw err;
    throw new OpsError(`${path} non è un database leggibile: ${(err as Error).message}`);
  } finally {
    client.close();
  }
}

/**
 * Copia consistente del database con `VACUUM INTO` (snapshot transazionale: il server può restare
 * acceso e scrivere, non si copia mai il file mentre cambia), poi i file caricati, poi la rotazione.
 * La cartella viene prima costruita come `.partial` e rinominata solo a copia finita e verificata.
 */
export async function createBackup(opts: BackupOptions): Promise<BackupResult> {
  const { dbPath, uploadDir, backupDir, keep } = opts;
  if (!Number.isInteger(keep) || keep < 1) throw new OpsError("BACKUP_KEEP deve essere un intero >= 1.");
  if (!existsSync(dbPath)) throw new OpsError(`Database non trovato: ${dbPath}`);
  const root = resolve(backupDir);
  // Evita di salvare il backup dentro i dati che sta copiando (si moltiplicherebbe a ogni giro).
  if (resolve(uploadDir) === root || root.startsWith(resolve(uploadDir) + "/")) {
    throw new OpsError("BACKUP_DIR non può stare dentro UPLOAD_DIR.");
  }
  await mkdir(root, { recursive: true });

  const base = `lanterna-${stamp(opts.now ?? new Date())}`;
  let name = base;
  for (let n = 1; existsSync(join(root, name)) || existsSync(join(root, `${name}.partial`)); n++) name = `${base}-${n}`;
  const partial = join(root, `${name}.partial`);
  await mkdir(partial);
  const dbFile = join(partial, BACKUP_DB_NAME);

  try {
    const client = createClient({ url: `file:${dbPath}` });
    try {
      await client.execute(`VACUUM INTO '${dbFile.replaceAll("'", "''")}'`);
    } finally {
      client.close();
    }
    await verifySqlite(dbFile);
    let uploadsCopied = false;
    if (existsSync(uploadDir)) {
      await cp(uploadDir, join(partial, BACKUP_UPLOADS_NAME), { recursive: true, errorOnExist: true });
      uploadsCopied = true;
    }
    const final = join(root, name);
    await rename(partial, final);
    const removed = await rotateBackups(root, keep);
    return { dir: final, dbFile: join(final, BACKUP_DB_NAME), uploadsCopied, removed };
  } catch (err) {
    await rm(partial, { recursive: true, force: true });
    throw err;
  }
}

/** Elimina le copie più vecchie oltre le ultime `keep`. Tocca solo cartelle con il nostro nome. */
export async function rotateBackups(root: string, keep: number): Promise<string[]> {
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && BACKUP_DIR.test(e.name))
    .map((e) => e.name)
    .sort();
  const old = names.slice(0, Math.max(0, names.length - keep));
  for (const n of old) await rm(join(root, n), { recursive: true, force: true });
  return old.map((n) => join(root, n));
}

export interface RestoreOptions {
  /** Cartella di backup (con `lanterna.db` ed eventualmente `uploads/`) oppure un file `.db`. */
  source: string;
  dbPath: string;
  uploadDir: string;
  now?: Date;
}

export interface RestoreResult {
  dbPath: string;
  /** Dove sono finiti i dati precedenti (per poter tornare indietro), se c'erano. */
  previousDb: string | null;
  previousUploads: string | null;
  uploadsRestored: boolean;
}

/**
 * Ripristino. Il server DEVE essere fermo (il chiamante lo fa confermare). Controlla la sorgente
 * prima di toccare qualsiasi cosa; i dati attuali non vengono cancellati ma spostati accanto
 * con suffisso `.prima-del-ripristino-<data>`.
 */
export async function restoreBackup(opts: RestoreOptions): Promise<RestoreResult> {
  const source = resolve(opts.source);
  if (!existsSync(source)) throw new OpsError(`Sorgente non trovata: ${source}`);
  const isDir = (await stat(source)).isDirectory();
  const srcDb = isDir ? join(source, BACKUP_DB_NAME) : source;
  const srcUploads = isDir ? join(source, BACKUP_UPLOADS_NAME) : null;
  await verifySqlite(srcDb);

  const tag = `.prima-del-ripristino-${stamp(opts.now ?? new Date())}`;
  const { dbPath, uploadDir } = opts;
  await mkdir(dirname(dbPath), { recursive: true });

  let previousDb: string | null = null;
  if (existsSync(dbPath)) {
    previousDb = dbPath + tag;
    await rename(dbPath, previousDb);
  }
  // WAL e SHM del vecchio database non devono mai accoppiarsi con il nuovo file.
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) await rename(dbPath + suffix, previousDb ? previousDb + suffix : `${dbPath}${suffix}${tag}`);
  }
  await cp(srcDb, dbPath, { errorOnExist: true });

  let previousUploads: string | null = null;
  let uploadsRestored = false;
  if (srcUploads && existsSync(srcUploads)) {
    if (existsSync(uploadDir)) {
      previousUploads = uploadDir.replace(/\/+$/, "") + tag;
      await rename(uploadDir, previousUploads);
    }
    await cp(srcUploads, uploadDir, { recursive: true, errorOnExist: true });
    uploadsRestored = true;
  }
  await verifySqlite(dbPath);
  return { dbPath, previousDb, previousUploads, uploadsRestored };
}
