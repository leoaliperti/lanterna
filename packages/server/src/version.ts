import { readFileSync } from "node:fs";

/** Versione dell'app (`packages/server/package.json`), scritta nel manifesto delle esportazioni. */
function readVersion(): string {
  try {
    // Da `src/` e da `dist/` il file sta un livello sopra.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version.slice(0, 32) : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const APP_VERSION = readVersion();
