import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { ARCHIVE_FORMAT, ARCHIVE_FORMAT_VERSION, PROTOCOL_VERSION } from "@lanterna/shared";

/* Costruzione di archivi (validi e malevoli) per i test. Nessun file binario nel repo. */

export type Entry = Uint8Array | string | object;

const bytes = (e: Entry): Uint8Array =>
  e instanceof Uint8Array ? e : new TextEncoder().encode(typeof e === "string" ? e : JSON.stringify(e));

/** Documenti minimi validi di un archivio (nessuna scena, nessun membro). */
export function emptyDocs(): Record<string, Entry> {
  return {
    "campaign.json": { name: "Campagna importata", activeSceneId: null },
    "members.json": [],
    "scenes.json": [],
    "tokens.json": [],
    "fog.json": [],
    "walls.json": [],
    "combats.json": [],
    "groups.json": [],
    "sheets.json": [],
    "content.json": [],
    "library.json": [],
    "assets.json": [],
  };
}

export interface BuildOptions {
  /** Sovrascrive campi del manifesto (es. `formatVersion`). */
  manifest?: Record<string, unknown>;
  /** Non scrive il manifesto. */
  noManifest?: boolean;
  /** Non aggiunge al manifesto queste voci (file "non elencati"). */
  unlisted?: string[];
  /** Livello di compressione (0 = nessuna). */
  level?: 0 | 6;
}

/** Zip con il manifesto calcolato (dimensioni e SHA-256 veri) sui file passati. */
export function buildZip(files: Record<string, Entry>, options: BuildOptions = {}): Buffer {
  const out: Record<string, Uint8Array> = {};
  const list: { path: string; bytes: number; sha256: string }[] = [];
  for (const [name, entry] of Object.entries(files)) {
    const data = bytes(entry);
    out[name] = data;
    if (!options.unlisted?.includes(name)) {
      list.push({ path: name, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
    }
  }
  if (!options.noManifest) {
    const manifest = {
      format: ARCHIVE_FORMAT,
      formatVersion: ARCHIVE_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: "test",
      protocolVersion: PROTOCOL_VERSION,
      campaignName: "Campagna importata",
      includesChat: "chat.json" in files,
      counts: { members: 0, scenes: 0, tokens: 0, walls: 0, fogs: 0, combats: 0, groups: 0, sheets: 0, content: 0, library: 0, chat: 0, assets: 0 },
      files: list,
      warnings: [],
      ...options.manifest,
    };
    out["manifest.json"] = bytes(manifest);
  }
  return Buffer.from(zipSync(out, { level: options.level ?? 6 }));
}

/** Corpo multipart/form-data con il campo `options` (JSON) PRIMA del file, come fa il client. */
export function importForm(zip: Uint8Array, options?: unknown, filename = "campagna.zip"): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----lanterna-test-import";
  const parts: Buffer[] = [];
  if (options !== undefined) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="options"\r\n\r\n${typeof options === "string" ? options : JSON.stringify(options)}\r\n`),
    );
  }
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`),
    Buffer.from(zip),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
