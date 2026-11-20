// Importa contenuti di gioco (JSON) nel database dell'istanza:
//   npm run import-content -w @lanterna/server -- <file.json | cartella>
// Formato in docs/CONTENT.md. Ogni file è importato in una transazione (tutto o niente);
// se un file non è valido non si importa nulla da nessun file.
import { loadConfig, loadDotEnv } from "../config.js";
import { openDatabase } from "../db/client.js";
import { listJsonFiles, readContentFile } from "../content/files.js";
import { ContentValidationError } from "../content/schema.js";
import { UnknownCampaignError, importContent } from "../content/store.js";

loadDotEnv();
const target = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!target) {
  console.error("Uso: npm run import-content -w @lanterna/server -- <file.json | cartella>");
  process.exit(2);
}

try {
  const config = loadConfig();
  const files = await listJsonFiles(target);
  if (files.length === 0) throw new ContentValidationError(`Nessun file .json in ${target}`);
  // Prima si valida tutto, poi si scrive.
  const parsed = [];
  for (const f of files) parsed.push({ file: f, content: await readContentFile(f, config.contentMaxBytes) });

  const database = await openDatabase(config.databaseUrl);
  try {
    let created = 0;
    let updated = 0;
    for (const { file, content } of parsed) {
      const r = await importContent(database.db, content);
      created += r.created;
      updated += r.updated;
      console.log(`${file}: ${r.created} nuovi, ${r.updated} aggiornati`);
    }
    console.log(`Fatto: ${created} nuovi, ${updated} aggiornati in ${parsed.length} file.`);
  } finally {
    database.close();
  }
} catch (err) {
  if (err instanceof ContentValidationError) {
    console.error(`Importazione annullata: ${err.message}`);
    for (const i of err.issues) console.error(`  - ${i}`);
  } else if (err instanceof UnknownCampaignError) {
    console.error(`Importazione annullata: ${err.message}`);
  } else {
    console.error(`Importazione fallita: ${(err as Error).message}`);
  }
  process.exit(1);
}
