import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { ContentValidationError, LIMITS, parseContent, type ParsedContent } from "./schema.js";

/** Elenca i `.json` di un percorso: il file stesso, oppure i file di una cartella (ricorsivo, ordinati). */
export async function listJsonFiles(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === ".json") out.push(full);
      if (out.length > LIMITS.maxFiles) throw new ContentValidationError(`Troppi file (massimo ${LIMITS.maxFiles})`);
    }
  }
  await walk(path);
  return out;
}

/** Legge e valida un file. La `source` di ripiego è il nome del file senza estensione. */
export async function readContentFile(path: string, maxBytes: number): Promise<ParsedContent> {
  const info = await stat(path);
  if (info.size > maxBytes) throw new ContentValidationError(`${path}: file oltre ${maxBytes} byte`);
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ContentValidationError(`${path}: JSON non valido`);
  }
  try {
    return parseContent(json, basename(path, extname(path)));
  } catch (err) {
    if (err instanceof ContentValidationError) throw new ContentValidationError(`${path}: ${err.message}`, err.issues);
    throw err;
  }
}
