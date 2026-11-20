// Ripristino da backup:
//   npm run restore -w @lanterna/server -- <cartella-backup | file.db> [--yes]
// IL SERVER VA FERMATO prima. I dati attuali non si cancellano: vengono spostati accanto al
// nuovo con il suffisso ".prima-del-ripristino-<data>".
import { createInterface } from "node:readline/promises";
import { loadConfig, loadDotEnv } from "../config.js";
import { dbPathFromUrl, OpsError, restoreBackup } from "../ops/backup.js";

loadDotEnv();
const args = process.argv.slice(2);
const yes = args.includes("--yes");
const source = args.find((a) => !a.startsWith("--"));
if (!source) {
  console.error("Uso: npm run restore -w @lanterna/server -- <cartella-backup | file.db> [--yes]");
  process.exit(2);
}

try {
  const config = loadConfig();
  const dbPath = dbPathFromUrl(config.databaseUrl);
  console.log("ATTENZIONE: il server Lanterna deve essere FERMO. Ripristinare con il server acceso corrompe i dati.");
  console.log(`  database di destinazione: ${dbPath}`);
  console.log(`  cartella upload:          ${config.uploadDir}`);
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error("Input non interattivo: conferma di aver fermato il server aggiungendo --yes.");
      process.exit(2);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Il server è fermo e vuoi procedere? Scrivi 'si': ")).trim().toLowerCase();
    rl.close();
    if (answer !== "si" && answer !== "sì") {
      console.log("Annullato: nessuna modifica.");
      process.exit(1);
    }
  }
  const result = await restoreBackup({ source, dbPath, uploadDir: config.uploadDir });
  console.log(`Ripristinato: ${result.dbPath}`);
  if (result.previousDb) console.log(`  database precedente conservato in: ${result.previousDb}`);
  if (result.uploadsRestored) console.log(`  file caricati ripristinati${result.previousUploads ? `; precedenti in: ${result.previousUploads}` : ""}`);
  else console.log("  file caricati non toccati (la sorgente non li contiene)");
  console.log("Ora puoi riavviare il server.");
} catch (err) {
  console.error(`Ripristino fallito: ${err instanceof OpsError ? err.message : (err as Error).message}`);
  process.exit(1);
}
