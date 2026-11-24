import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp, createUser, signIn } from "../test/helpers.js";
import { createBackup, dbPathFromUrl, hasSqliteHeader, OpsError, restoreBackup, rotateBackups } from "./backup.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "lanterna-ops-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("backup → ripristino con dati reali", () => {
  it("la copia contiene utenti e file caricati; dopo il ripristino si accede come prima", async () => {
    const work = tmp();
    const dbPath = join(work, "data", "lanterna.db");
    const uploadDir = join(work, "uploads");
    mkdirSync(uploadDir, { recursive: true });
    writeFileSync(join(uploadDir, "mappa.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));

    // Server acceso con dati reali.
    const live = await createTestApp({}, () => {}, { dbPath, uploadDir });
    const gm = await createUser(live.app, "admin", "gm@example.com");
    expect((await signIn(live.app, gm.email)).statusCode).toBe(200);

    // Backup a server acceso (WAL attivo).
    const backupDir = join(work, "backups");
    const result = await createBackup({ dbPath, uploadDir, backupDir, keep: 3 });
    expect(result.uploadsCopied).toBe(true);
    expect(readFileSync(join(result.dir, "uploads", "mappa.png")).length).toBe(7);
    await expect(hasSqliteHeader(result.dbFile)).resolves.toBe(true);

    // Disastro: dopo il backup si crea un altro utente e si perde un file.
    await createUser(live.app, "player", "dopo@example.com");
    await live.close();
    rmSync(join(uploadDir, "mappa.png"));

    // Ripristino a server fermo.
    const restored = await restoreBackup({ source: result.dir, dbPath, uploadDir });
    expect(restored.previousDb).toMatch(/prima-del-ripristino/);
    expect(existsSync(restored.previousDb!)).toBe(true);
    expect(readdirSync(uploadDir).filter((f) => f !== "forms")).toEqual(["mappa.png"]);

    const again = await createTestApp({}, () => {}, { dbPath, uploadDir });
    try {
      expect((await signIn(again.app, "gm@example.com")).statusCode).toBe(200);
      // L'utente creato dopo il backup non c'è più.
      expect((await signIn(again.app, "dopo@example.com")).statusCode).toBe(401);
    } finally {
      await again.close();
    }
  });

  it("il backup resta consistente anche mentre il database viene scritto", async () => {
    const work = tmp();
    const dbPath = join(work, "lanterna.db");
    const live = await createTestApp({}, () => {}, { dbPath, uploadDir: join(work, "up") });
    try {
      let stop = false;
      let written = 0;
      const writer = (async () => {
        for (let i = 0; !stop; i++) {
          await live.app.database.client.execute({
            sql: "INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            args: [`v${i}`, "x", "y", Date.now() + 1000, Date.now(), Date.now()],
          });
          written = i + 1;
          // Cede il turno: il loop non deve affamare il resto del processo.
          await new Promise((r) => setImmediate(r));
        }
      })();
      const result = await createBackup({ dbPath, uploadDir: join(work, "up"), backupDir: join(work, "b"), keep: 2 });
      stop = true;
      await writer;
      expect(written).toBeGreaterThan(0);
      const copy = createClient({ url: `file:${result.dbFile}` });
      const check = await copy.execute("PRAGMA integrity_check");
      expect(check.rows[0]?.[0]).toBe("ok");
      copy.close();
    } finally {
      await live.close();
    }
  });

  it("rotazione: restano solo le ultime N, le altre cartelle non si toccano", async () => {
    const work = tmp();
    const dbPath = join(work, "lanterna.db");
    const live = await createTestApp({}, () => {}, { dbPath, uploadDir: join(work, "up") });
    const backupDir = join(work, "b");
    try {
      mkdirSync(join(backupDir, "altro"), { recursive: true });
      for (let i = 0; i < 4; i++) {
        await createBackup({ dbPath, uploadDir: join(work, "up"), backupDir, keep: 2, now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
      }
      const names = readdirSync(backupDir).sort();
      expect(names).toEqual(["altro", "lanterna-20260101-000002", "lanterna-20260101-000003"]);
      // Stesso secondo: nome diverso, nessuna sovrascrittura.
      const a = await createBackup({ dbPath, uploadDir: join(work, "up"), backupDir, keep: 9, now: new Date(Date.UTC(2026, 0, 1, 0, 0, 3)) });
      expect(a.dir).toMatch(/-1$/);
      expect(await rotateBackups(backupDir, 9)).toEqual([]);
    } finally {
      await live.close();
    }
  });

  it("senza cartella di upload copia solo il database", async () => {
    const work = tmp();
    const dbPath = join(work, "lanterna.db");
    const live = await createTestApp({}, () => {}, { dbPath, uploadDir: join(work, "nessuna") });
    try {
      rmSync(join(work, "nessuna"), { recursive: true, force: true });
      const r = await createBackup({ dbPath, uploadDir: join(work, "nessuna"), backupDir: join(work, "b"), keep: 1 });
      expect(r.uploadsCopied).toBe(false);
    } finally {
      await live.close();
    }
  });
});

describe("controlli di sicurezza", () => {
  it("il ripristino rifiuta file che non sono SQLite, senza toccare i dati attuali", async () => {
    const work = tmp();
    const dbPath = join(work, "lanterna.db");
    writeFileSync(dbPath, "dati attuali");
    const fake = join(work, "finto.db");
    writeFileSync(fake, "questo non è sqlite, anche se si chiama .db");
    await expect(restoreBackup({ source: fake, dbPath, uploadDir: join(work, "up") })).rejects.toThrow(/non è un database SQLite/);
    expect(readFileSync(dbPath, "utf8")).toBe("dati attuali");

    // Intestazione giusta ma contenuto troncato/corrotto.
    const truncated = join(work, "troncato.db");
    writeFileSync(truncated, Buffer.concat([Buffer.from("SQLite format 3\0", "latin1"), Buffer.alloc(100)]));
    await expect(restoreBackup({ source: truncated, dbPath, uploadDir: join(work, "up") })).rejects.toBeInstanceOf(OpsError);
    expect(readFileSync(dbPath, "utf8")).toBe("dati attuali");

    await expect(restoreBackup({ source: join(work, "manca"), dbPath, uploadDir: join(work, "up") })).rejects.toThrow(/non trovata/);
  });

  it("rifiuta un SQLite valido che non è di Lanterna", async () => {
    const work = tmp();
    const other = join(work, "altro.db");
    const c = createClient({ url: `file:${other}` });
    await c.execute("CREATE TABLE t (x)");
    c.close();
    await expect(restoreBackup({ source: other, dbPath: join(work, "l.db"), uploadDir: join(work, "up") })).rejects.toThrow(/non sembra un database di Lanterna/);
  });

  it("parametri non validi", async () => {
    const work = tmp();
    await expect(createBackup({ dbPath: join(work, "manca.db"), uploadDir: work, backupDir: join(work, "b"), keep: 1 })).rejects.toThrow(/non trovato/);
    expect(() => dbPathFromUrl("libsql://x.turso.io")).toThrow(OpsError);
    expect(() => dbPathFromUrl("file::memory:")).toThrow(OpsError);
    expect(dbPathFromUrl("file:./x.db")).toMatch(/x\.db$/);
  });

  it("BACKUP_DIR dentro UPLOAD_DIR è rifiutato", async () => {
    const work = tmp();
    const dbPath = join(work, "lanterna.db");
    const live = await createTestApp({}, () => {}, { dbPath, uploadDir: join(work, "up") });
    try {
      await expect(createBackup({ dbPath, uploadDir: join(work, "up"), backupDir: join(work, "up", "b"), keep: 1 })).rejects.toThrow(/dentro UPLOAD_DIR/);
    } finally {
      await live.close();
    }
  });
});
