import { buildApp } from "./app.js";
import { ConfigError, loadConfig, loadDotEnv } from "./config.js";

loadDotEnv();

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configurazione non valida: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

const app = await buildApp({ config });
await app.listen({ port, host });
