import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { asc, eq, inArray } from "drizzle-orm";
import { Zip, ZipDeflate } from "fflate";
import {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_LIMITS,
  PROTOCOL_VERSION,
  assetEntryName,
  parseSheetDoc,
  type ArchiveAsset,
  type ArchiveContent,
  type ArchiveCounts,
  type ArchiveLibraryItem,
  type ArchiveMember,
  type ArchiveSheet,
  type ChatLogEntry,
  type Fog,
  type Manifest,
} from "@lanterna/shared";
import { loadCampaign, loadMembers } from "../campaigns/store.js";
import { loadAll } from "../chat/store.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { asset as assetTable, characterSheet, content as contentTable } from "../db/schema.js";
import { itemsOfCampaign } from "../library/store.js";
import { parseAssetUrl } from "../media/assetUrl.js";
import { APP_VERSION } from "../version.js";
import { ArchiveError } from "./zip-read.js";

/** Un documento JSON già serializzato pronto per lo zip. */
interface JsonEntry {
  name: string;
  data: Buffer;
}

/** Un file immagine da copiare dal disco nello zip. */
interface AssetEntry {
  meta: ArchiveAsset;
  path: string;
}

export interface ExportPlan {
  /** Nome file suggerito (solo ASCII). */
  filename: string;
  /** Avvia lo streaming dello zip. Si può chiamare una volta sola. */
  stream(): Readable;
  counts: ArchiveCounts;
  warnings: string[];
}

export interface ExportOptions {
  /** Include la cronologia di chat e tiri (anche whisper e tiri segreti: è un backup del GM). */
  includeChat: boolean;
}

const CHUNK = 256 * 1024;

const json = (name: string, value: unknown): JsonEntry => ({ name, data: Buffer.from(JSON.stringify(value), "utf8") });

function slug(name: string): string {
  const s = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "campagna";
}

/**
 * Prepara l'esportazione di una campagna. Tutto ciò che può fallire (campagna inesistente, dati non
 * validi, archivio troppo grande) accade QUI, prima di inviare il primo byte: così l'errore diventa una
 * risposta HTTP normale. Poi `stream()` produce lo zip a pezzi, con memoria costante (le immagini sono
 * lette dal disco un chunk alla volta, con la contropressione della risposta).
 *
 * Cosa NON c'è mai nell'archivio: email, password o hash, sessioni, segreto di Better Auth, `.env`,
 * percorsi del server. Gli utenti compaiono solo come nome e ruolo (`members.json`) con un
 * riferimento opaco al posto dell'id.
 */
export async function planExport(db: Db, config: AppConfig, campaignId: string, options: ExportOptions): Promise<ExportPlan | null> {
  const loaded = await loadCampaign(db, campaignId);
  if (!loaded) return null;
  const state = loaded.state;
  const warnings: string[] = [];

  // --- Membri: id utente -> riferimento opaco ---------------------------------------------------
  const members = await loadMembers(db, campaignId);
  const refOf = new Map<string, string>();
  const archiveMembers: ArchiveMember[] = members.slice(0, ARCHIVE_LIMITS.maxMembers).map((m, i) => {
    const ref = `m${i + 1}`;
    refOf.set(m.userId, ref);
    return { ref, name: m.displayName, role: m.role };
  });
  let strangers = 0;
  const refForAuthor = (userId: string): string => {
    let ref = refOf.get(userId);
    if (!ref) {
      ref = `x${++strangers}`;
      refOf.set(userId, ref);
    }
    return ref;
  };
  const memberRef = (userId: string | null): string | null => (userId === null ? null : (refOf.get(userId) ?? null));

  // --- Documenti dello stato ---------------------------------------------------------------------
  const tokens = state.tokens.map((t) => ({ ...t, ownerUserId: memberRef(t.ownerUserId) }));
  const fogs: Fog[] = (state.fogs ?? []).map((f) => ({
    ...f,
    players: f.players
      .flatMap((p) => {
        const ref = refOf.get(p.userId);
        return ref ? [{ ...p, userId: ref }] : [];
      })
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)),
  }));

  // --- Schede ---------------------------------------------------------------------------------------
  const sheetRows = await db
    .select()
    .from(characterSheet)
    .where(eq(characterSheet.campaignId, campaignId))
    .orderBy(asc(characterSheet.createdAt), asc(characterSheet.id));
  const sheets: ArchiveSheet[] = [];
  for (const row of sheetRows.slice(0, ARCHIVE_LIMITS.maxSheets)) {
    try {
      sheets.push({ kind: row.kind, ownerRef: memberRef(row.ownerUserId), tokenId: row.tokenId, doc: parseSheetDoc(JSON.parse(row.data)) });
    } catch {
      warnings.push(`Scheda "${row.name.slice(0, 60)}" non valida: non esportata.`);
    }
  }

  // --- Contenuti importati collegati alla campagna ------------------------------------------------
  const contentRows = await db
    .select()
    .from(contentTable)
    .where(eq(contentTable.campaignId, campaignId))
    .orderBy(asc(contentTable.name), asc(contentTable.id));
  const contentDocs: ArchiveContent[] = contentRows.slice(0, ARCHIVE_LIMITS.maxContent).map((r) => ({
    kind: r.kind,
    name: r.name,
    source: r.source,
    data: JSON.parse(r.data) as Record<string, unknown>,
  }));

  // --- Libreria della campagna (la libreria globale non fa parte della campagna) ----------------------
  const library: ArchiveLibraryItem[] = (await itemsOfCampaign(db, campaignId)).map((i) => ({
    name: i.name,
    kind: i.kind,
    size: i.size,
    imageUrl: i.imageUrl,
    stats: i.stats,
    tags: i.tags,
  }));

  // --- Chat (facoltativa) ----------------------------------------------------------------------------------
  let chat: ChatLogEntry[] = [];
  if (options.includeChat) {
    const all = await loadAll(db, campaignId, null);
    if (all.length > ARCHIVE_LIMITS.maxChatEntries) {
      warnings.push(`Cronologia limitata alle ultime ${ARCHIVE_LIMITS.maxChatEntries} voci (su ${all.length}).`);
    }
    chat = all.slice(-ARCHIVE_LIMITS.maxChatEntries).map((e) => ({
      ...e,
      authorId: refForAuthor(e.authorId),
      whisperTo: e.whisperTo === null ? null : refForAuthor(e.whisperTo),
    }));
  }

  // --- Immagini usate (mappe, token, libreria) -------------------------------------------------------------
  const wanted = new Set<string>();
  const noteUrl = (url: string | null) => {
    const p = url ? parseAssetUrl(url) : null;
    if (p) wanted.add(p.id);
  };
  for (const s of state.scenes) if (s.map) wanted.add(s.map.assetId);
  for (const t of state.tokens) noteUrl(t.imageUrl);
  for (const i of library) noteUrl(i.imageUrl);
  const assetRows =
    wanted.size === 0 ? [] : await db.select().from(assetTable).where(inArray(assetTable.id, [...wanted]));
  const root = resolve(config.uploadDir);
  const assets: AssetEntry[] = [];
  for (const row of assetRows.sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const path = resolve(root, `${row.id}.${row.ext}`);
    const ok = path.startsWith(root + sep) && (await stat(path).then((s) => s.isFile(), () => false));
    if (!ok) {
      warnings.push(`Immagine ${row.id} mancante sul disco: non esportata.`);
      continue;
    }
    assets.push({
      meta: { id: row.id, kind: row.kind, mime: row.mime, ext: row.ext as ArchiveAsset["ext"], width: row.width, height: row.height, bytes: row.bytes },
      path,
    });
  }
  const foundIds = new Set(assetRows.map((r) => r.id));
  for (const id of wanted) if (!foundIds.has(id)) warnings.push(`Immagine ${id} inesistente: non esportata.`);

  // --- Documenti pronti ----------------------------------------------------------------------------------------
  const counts: ArchiveCounts = {
    members: archiveMembers.length,
    scenes: state.scenes.length,
    tokens: tokens.length,
    walls: state.walls?.length ?? 0,
    fogs: fogs.length,
    combats: state.combats?.length ?? 0,
    groups: state.groups?.length ?? 0,
    sheets: sheets.length,
    content: contentDocs.length,
    library: library.length,
    chat: chat.length,
    assets: assets.length,
  };
  const docs: JsonEntry[] = [
    json("campaign.json", { name: state.name, activeSceneId: state.activeSceneId }),
    json("members.json", archiveMembers),
    json("scenes.json", state.scenes),
    json("tokens.json", tokens),
    json("fog.json", fogs),
    json("walls.json", state.walls ?? []),
    json("combats.json", state.combats ?? []),
    json("groups.json", state.groups ?? []),
    json("sheets.json", sheets),
    json("content.json", contentDocs),
    json("library.json", library),
    ...(options.includeChat ? [json("chat.json", chat)] : []),
    json("assets.json", assets.map((a) => a.meta)),
  ];

  // Limite di dimensione, controllato prima di iniziare.
  const jsonBytes = docs.reduce((n, d) => n + d.data.length, 0);
  const assetBytes = assets.reduce((n, a) => n + a.meta.bytes, 0);
  for (const d of docs) {
    if (d.data.length > config.archive.maxJsonBytes) {
      throw new ArchiveError(413, `Il documento "${d.name}" supera il limite di ${Math.round(config.archive.maxJsonBytes / 1048576)} MiB.`);
    }
  }
  if (jsonBytes + assetBytes > config.archive.maxBytes || jsonBytes + assetBytes > config.archive.maxUnpackedBytes) {
    throw new ArchiveError(413, "La campagna è troppo grande per essere esportata (vedi ARCHIVE_MAX_BYTES).");
  }
  if (docs.length + assets.length + 1 > config.archive.maxEntries) {
    throw new ArchiveError(413, "Troppi file da esportare (vedi ARCHIVE_MAX_ENTRIES).");
  }

  const exportedAt = new Date();
  const filename = `lanterna-${slug(state.name)}-${exportedAt.toISOString().slice(0, 10).replace(/-/g, "")}.zip`;

  async function* chunks(): AsyncGenerator<Buffer> {
    const queue: Buffer[] = [];
    let error: Error | null = null;
    const zip = new Zip((err, chunk) => {
      if (err) error = err;
      else queue.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    });
    const files: Manifest["files"] = [];
    const flush = function* () {
      if (error) throw error;
      while (queue.length > 0) yield queue.shift()!;
    };

    for (const d of docs) {
      const f = new ZipDeflate(d.name, { level: 6 });
      zip.add(f);
      for (let o = 0; o < d.data.length; o += CHUNK) f.push(d.data.subarray(o, o + CHUNK), false);
      f.push(new Uint8Array(0), true);
      files.push({ path: d.name, bytes: d.data.length, sha256: createHash("sha256").update(d.data).digest("hex") });
      yield* flush();
    }
    for (const a of assets) {
      // Le immagini sono già compresse: livello 0 (nessun tempo perso, stesso formato zip).
      const name = assetEntryName(a.meta.id, a.meta.ext);
      const f = new ZipDeflate(name, { level: 0 });
      zip.add(f);
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const part of createReadStream(a.path, { highWaterMark: CHUNK })) {
        const buf = part as Buffer;
        hash.update(buf);
        bytes += buf.length;
        f.push(buf, false);
        yield* flush();
      }
      f.push(new Uint8Array(0), true);
      files.push({ path: name, bytes, sha256: hash.digest("hex") });
      yield* flush();
    }

    const manifest: Manifest = {
      format: ARCHIVE_FORMAT,
      formatVersion: ARCHIVE_FORMAT_VERSION,
      exportedAt: exportedAt.toISOString(),
      appVersion: APP_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      campaignName: state.name,
      includesChat: options.includeChat,
      counts,
      files,
      warnings: warnings.slice(0, 100),
    };
    const m = new ZipDeflate("manifest.json", { level: 6 });
    zip.add(m);
    m.push(Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), true);
    zip.end();
    yield* flush();
  }

  let started = false;
  return {
    filename,
    counts,
    warnings,
    stream() {
      if (started) throw new Error("stream() già chiamato");
      started = true;
      return Readable.from(chunks(), { objectMode: false });
    },
  };
}
