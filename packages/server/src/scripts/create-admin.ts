// Crea il primo admin (GM) da riga di comando:
//   npm run create-admin -w @lanterna/server
// Valori da variabili d'ambiente (LANTERNA_ADMIN_EMAIL, LANTERNA_ADMIN_NAME, LANTERNA_ADMIN_PASSWORD)
// o, se mancano, chiesti al prompt (la password senza eco). La password non viene mai stampata.
import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";
import { createAuth } from "../auth/auth.js";
import { loadConfig, loadDotEnv } from "../config.js";
import { openDatabase } from "../db/client.js";
import { createUserService } from "../users/service.js";
import { ensureAdmin } from "./ensure-admin.js";

// Un'unica interfaccia readline per tutto lo script: le righe vengono lette in ordine,
// anche quando l'input arriva da una pipe. L'eco del terminale passa da `output` e si può spegnere.
let muted = false;
let rl: Interface | undefined;
let lines: AsyncIterator<string> | undefined;

async function ask(question: string, hidden = false): Promise<string> {
  if (!rl || !lines) {
    const output = new Writable({
      write(chunk, _enc, done) {
        if (!muted) process.stdout.write(chunk);
        done();
      },
    });
    rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
    lines = rl[Symbol.asyncIterator]();
  }
  process.stdout.write(question);
  muted = hidden;
  try {
    const next = await lines.next();
    if (next.done) throw new Error("input terminato: usa le variabili LANTERNA_ADMIN_*");
    return next.value.trim();
  } finally {
    muted = false;
    if (hidden) process.stdout.write("\n");
  }
}

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const email = process.env.LANTERNA_ADMIN_EMAIL?.trim() || (await ask("Email dell'admin: "));
  if (!email) throw new Error("Email obbligatoria.");

  const database = await openDatabase(config.databaseUrl);
  try {
    const users = createUserService(database.db, createAuth(config, database.db));
    // Idempotente: se l'admin c'è già non chiede altro e non tocca nulla
    // (se l'email è di un giocatore, ensureAdmin rifiuta prima di usare la password).
    const existing = await users.findByEmail(email);
    if (existing) {
      const result = await ensureAdmin(users, { email, name: existing.name, password: "" });
      console.log(`L'admin ${result.user.email} esiste già: nessuna modifica.`);
      return;
    }
    const name = process.env.LANTERNA_ADMIN_NAME?.trim() || (await ask("Nome visualizzato: ")) || "GM";
    let password = process.env.LANTERNA_ADMIN_PASSWORD;
    if (!password) {
      password = await ask("Password (non viene mostrata): ", true);
      const confirm = await ask("Ripeti la password: ", true);
      if (password !== confirm) throw new Error("Le password non coincidono.");
    }
    const result = await ensureAdmin(users, { email, name, password });
    console.log(`Admin creato: ${result.user.email}`);
  } finally {
    rl?.close();
    database.close();
  }
}

main().catch((err: unknown) => {
  // Solo il messaggio: niente stack né valori inseriti (la password non finisce mai nei log).
  console.error(`create-admin: ${err instanceof Error ? err.message : "errore sconosciuto"}`);
  process.exit(1);
});
