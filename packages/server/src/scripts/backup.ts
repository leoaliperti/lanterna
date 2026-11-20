// Backup consistente di database e file caricati:
//   npm run backup -w @lanterna/server
// Si può lanciare a server acceso (VACUUM INTO è uno snapshot transazionale).
// Variabili: BACKUP_DIR (default ./backups), BACKUP_KEEP (default 7), DATABASE_URL, UPLOAD_DIR.
import { loadConfig, loadDotEnv } from "../config.js";
import { createBackup, dbPathFromUrl, OpsError } from "../ops/backup.js";

loadDotEnv();
try {
  const config = loadConfig();
  const keep = Number(process.env.BACKUP_KEEP ?? 7);
  const result = await createBackup({
    dbPath: dbPathFromUrl(config.databaseUrl),
    uploadDir: config.uploadDir,
    backupDir: process.env.BACKUP_DIR ?? "./backups",
    keep,
  });
  console.log(`Backup creato: ${result.dir}`);
  console.log(result.uploadsCopied ? "  database + file caricati" : "  solo database (nessuna cartella di upload)");
  if (result.removed.length > 0) console.log(`  ruotati ${result.removed.length} backup vecchi (si tengono gli ultimi ${keep})`);
} catch (err) {
  console.error(`Backup fallito: ${err instanceof OpsError ? err.message : (err as Error).message}`);
  process.exit(1);
}
