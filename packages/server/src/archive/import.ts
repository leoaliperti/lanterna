import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import {
  ARCHIVE_ASSET_ENTRY,
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_JSON_FILES,
  ARCHIVE_LIMITS,
  ArchiveAssetSchema,
  ArchiveCampaignSchema,
  ArchiveChatEntrySchema,
  ArchiveContentSchema,
  ArchiveLibraryItemSchema,
  ArchiveMemberSchema,
  ArchiveSheetSchema,
  CampaignStateSchema,
  CombatSchema,
  FogSchema,
  GroupSchema,
  ImportOptionsSchema,
  LIMITS,
  ManifestSchema,
  PROTOCOL_VERSION,
  SceneSchema,
  TokenSchema,
  WallSchema,
  assetEntryName,
  checkInvariants,
  deriveDoc,
  sheetDocSchema,
  type ArchiveAsset,
  type ArchiveCounts,
  type ArchiveMember,
  type CampaignState,
  type ChatLogEntry,
  type ImportPreview,
  type ImportResult,
  type Manifest,
  type Member,
  type SheetDoc,
} from "@lanterna/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  asset as assetTable,
  campaign as campaignTable,
  campaignMember,
  characterSheet,
  chatEntry,
  combat as combatTable,
  content as contentTable,
  fog as fogTable,
  libraryItem,
  scene as sceneTable,
  token as tokenTable,
  tokenGroup,
  user as userTable,
  wall as wallTable,
} from "../db/schema.js";
import { ContentItemSchema, findForbiddenKey } from "../content/schema.js";
import { keyOf } from "../content/store.js";
import { exceedsImageLimits, sniffImage, type ImageInfo } from "../media/image.js";
import { assetUrlOf, parseAssetUrl } from "../media/assetUrl.js";
import { ArchiveError, readZipFile, safeName } from "./zip-read.js";

/** Immagine verificata, parcheggiata su disco in attesa della conferma. */
interface StagedImage {
  meta: ArchiveAsset;
  info: ImageInfo;
  /** File nella cartella di parcheggio (`UPLOAD_DIR/.import-<uuid>/`). */
  path: string;
  bytes: number;
}

/** Contenuto di un archivio validato, ancora con gli id originali. */
export interface StagedArchive {
  manifest: Manifest;
  campaign: z.infer<typeof ArchiveCampaignSchema>;
  members: ArchiveMember[];
  scenes: z.infer<typeof SceneSchema>[];
  tokens: z.infer<typeof TokenSchema>[];
  fogs: z.infer<typeof FogSchema>[];
  walls: z.infer<typeof WallSchema>[];
  combats: z.infer<typeof CombatSchema>[];
  groups: z.infer<typeof GroupSchema>[];
  sheets: { kind: "pc" | "monster"; ownerRef: string | null; tokenId: string | null; doc: SheetDoc }[];
  content: z.infer<typeof ContentItemSchema>[];
  library: z.infer<typeof ArchiveLibraryItemSchema>[];
  chat: ChatLogEntry[] | null;
  images: StagedImage[];
  unpackedBytes: number;
}

const JSON_NAMES = new Set<string>(ARCHIVE_JSON_FILES);
const REQUIRED = ARCHIVE_JSON_FILES.filter((n) => n !== "chat.json" && n !== "manifest.json");

function issuesOf(file: string, error: z.ZodError): ArchiveError {
  const details = error.issues.slice(0, 5).map((i) => `${file}: ${i.path.join(".") || "(radice)"}: ${i.message}`);
  return new ArchiveError(400, `Il documento ${file} non è valido.`, details);
}

function parseJson(file: string, data: Buffer): unknown {
  try {
    return JSON.parse(data.toString("utf8"));
  } catch {
    throw new ArchiveError(400, `Il documento ${file} non è un JSON valido.`);
  }
}

function parseWith<T>(file: string, schema: z.ZodType<T>, data: Buffer): T {
  const r = schema.safeParse(parseJson(file, data));
  if (!r.success) throw issuesOf(file, r.error);
  return r.data;
}

/**
 * Legge e valida uno zip NON fidato. Non scrive nulla nel database né in `UPLOAD_DIR` (a parte la
 * cartella di parcheggio `stagingDir`, che il chiamante cancella sempre). Ogni documento passa da Zod,
 * ogni immagine dal controllo dei magic bytes e dai limiti dell'upload, ogni file dal manifesto (dimensione
 * e SHA-256). Lancia `ArchiveError` al primo problema: tutto o niente.
 */
export async function stageArchive(zipPath: string, stagingDir: string, config: AppConfig): Promise<StagedArchive> {
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  const docs = new Map<string, Buffer>();
  const images = new Map<string, StagedImage & { sha256: string }>();
  let unpacked = 0;
  let counter = 0;

  await readZipFile(zipPath, {
    maxEntries: config.archive.maxEntries,
    maxTotalBytes: config.archive.maxUnpackedBytes,
    admit(name) {
      if (JSON_NAMES.has(name)) return config.archive.maxJsonBytes;
      if (ARCHIVE_ASSET_ENTRY.test(name)) return config.upload.maxBytes;
      throw new ArchiveError(400, `Archivio non valido: voce non ammessa "${safeName(name)}".`);
    },
    onEntry(name, data) {
      unpacked += data.length;
      if (JSON_NAMES.has(name)) {
        docs.set(name, data);
        return;
      }
      const m = ARCHIVE_ASSET_ENTRY.exec(name)!;
      // Tipo reale dai magic bytes, come per l'upload: estensione e nome nell'archivio non contano.
      const info = sniffImage(data);
      if (!info) throw new ArchiveError(415, `L'immagine "${safeName(name)}" non è un PNG, JPEG o WebP valido.`);
      if (info.ext !== m[2]) throw new ArchiveError(415, `L'immagine "${safeName(name)}" non corrisponde alla sua estensione.`);
      if (exceedsImageLimits(info, config.upload)) throw new ArchiveError(413, `L'immagine "${safeName(name)}" è troppo grande in pixel.`);
      const path = join(stagingDir, `${++counter}.img`);
      const meta: ArchiveAsset = { id: m[1]!, kind: "map", mime: info.mime, ext: info.ext, width: info.width, height: info.height, bytes: data.length };
      images.set(name, { meta, info, path, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
      return writeFile(path, data, { flag: "wx", mode: 0o600 });
    },
  });

  // --- Manifesto e integrità ------------------------------------------------------------------------
  const manifestRaw = docs.get("manifest.json");
  if (!manifestRaw) throw new ArchiveError(400, "Archivio non valido: manca manifest.json.");
  const manifest = parseWith("manifest.json", ManifestSchema, manifestRaw);
  if (manifest.formatVersion > ARCHIVE_FORMAT_VERSION) {
    throw new ArchiveError(422, "L'archivio è stato creato da una versione più recente di Lanterna: aggiorna l'app prima di importarlo.");
  }
  if (manifest.protocolVersion > PROTOCOL_VERSION) {
    throw new ArchiveError(422, "L'archivio usa una versione del protocollo più recente di quella di questo server.");
  }
  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  if (listed.size !== manifest.files.length) throw new ArchiveError(400, "Manifesto non valido: file duplicati.");
  const present = new Map<string, { bytes: number; sha256: string }>();
  for (const [name, data] of docs) {
    if (name !== "manifest.json") present.set(name, { bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
  }
  for (const [name, im] of images) present.set(name, { bytes: im.bytes, sha256: im.sha256 });
  for (const [name, p] of present) {
    const f = listed.get(name);
    if (!f) throw new ArchiveError(400, `Archivio non valido: "${safeName(name)}" non è elencato nel manifesto.`);
    if (f.bytes !== p.bytes || f.sha256 !== p.sha256) {
      throw new ArchiveError(400, `Archivio danneggiato o modificato: "${safeName(name)}" non corrisponde al manifesto.`);
    }
  }
  for (const name of listed.keys()) {
    if (!present.has(name)) throw new ArchiveError(400, `Archivio incompleto: manca "${safeName(name)}".`);
  }
  for (const name of REQUIRED) if (!docs.has(name)) throw new ArchiveError(400, `Archivio non valido: manca ${name}.`);
  if (manifest.includesChat !== docs.has("chat.json")) throw new ArchiveError(400, "Manifesto incoerente con la presenza della cronologia.");

  // --- Documenti (Zod su ognuno) -----------------------------------------------------------------------
  const get = (n: string) => docs.get(n)!;
  const campaign = parseWith("campaign.json", ArchiveCampaignSchema, get("campaign.json"));
  const members = parseWith("members.json", z.array(ArchiveMemberSchema).max(ARCHIVE_LIMITS.maxMembers), get("members.json"));
  if (new Set(members.map((m) => m.ref)).size !== members.length) throw new ArchiveError(400, "members.json: riferimenti duplicati.");
  const scenes = parseWith("scenes.json", z.array(SceneSchema).max(LIMITS.maxScenes), get("scenes.json"));
  const tokens = parseWith("tokens.json", z.array(TokenSchema).max(LIMITS.maxTokens), get("tokens.json"));
  const fogs = parseWith("fog.json", z.array(FogSchema).max(LIMITS.maxScenes), get("fog.json"));
  const walls = parseWith("walls.json", z.array(WallSchema).max(LIMITS.maxWalls), get("walls.json"));
  const combats = parseWith("combats.json", z.array(CombatSchema).max(LIMITS.maxScenes), get("combats.json"));
  const groups = parseWith("groups.json", z.array(GroupSchema).max(LIMITS.maxGroups), get("groups.json"));
  const library = parseWith("library.json", z.array(ArchiveLibraryItemSchema).max(2000), get("library.json"));
  const assetMetas = parseWith("assets.json", z.array(ArchiveAssetSchema).max(ARCHIVE_LIMITS.maxAssets), get("assets.json"));
  const rawSheets = parseWith("sheets.json", z.array(ArchiveSheetSchema).max(ARCHIVE_LIMITS.maxSheets), get("sheets.json"));
  const sheets = rawSheets.map((s, i) => {
    const r = sheetDocSchema.safeParse(s.doc);
    if (!r.success) throw issuesOf(`sheets.json[${i}]`, r.error);
    try {
      deriveDoc(r.data);
    } catch {
      throw new ArchiveError(400, `sheets.json[${i}]: scheda non calcolabile.`);
    }
    return { kind: s.kind, ownerRef: s.ownerRef, tokenId: s.tokenId, doc: r.data };
  });
  // Zod scarta in silenzio `__proto__` nei record: si cerca nel JSON grezzo, prima.
  const forbiddenKey = findForbiddenKey(parseJson("content.json", get("content.json")));
  if (forbiddenKey) throw new ArchiveError(400, `content.json: ${forbiddenKey}.`);
  const rawContent = parseWith("content.json", z.array(ArchiveContentSchema).max(ARCHIVE_LIMITS.maxContent), get("content.json"));
  const content = rawContent.map((c, i) => {
    // Come per l'importazione dei contenuti: niente HTML, profondità e dimensioni limitate, niente `__proto__`.
    const forbidden = findForbiddenKey(c.data);
    if (forbidden) throw new ArchiveError(400, `content.json[${i}]: ${forbidden}.`);
    const r = ContentItemSchema.safeParse({ kind: c.kind, name: c.name, source: c.source || undefined, data: c.data });
    if (!r.success) throw issuesOf(`content.json[${i}]`, r.error);
    return { ...r.data, source: r.data.source ?? "" };
  });
  const chat = docs.has("chat.json")
    ? parseWith("chat.json", z.array(ArchiveChatEntrySchema).max(ARCHIVE_LIMITS.maxChatEntries), get("chat.json"))
    : null;

  // --- Immagini <-> assets.json ------------------------------------------------------------------------------
  const staged: StagedImage[] = [];
  const metaIds = new Set<string>();
  for (const meta of assetMetas) {
    if (metaIds.has(meta.id)) throw new ArchiveError(400, "assets.json: immagini duplicate.");
    metaIds.add(meta.id);
    const im = images.get(assetEntryName(meta.id, meta.ext));
    if (!im) throw new ArchiveError(400, `Archivio incompleto: manca l'immagine ${meta.id}.`);
    if (meta.mime !== im.info.mime || meta.width !== im.info.width || meta.height !== im.info.height || meta.bytes !== im.bytes) {
      throw new ArchiveError(415, `L'immagine ${meta.id} non corrisponde a quanto dichiarato.`);
    }
    staged.push({ meta, info: im.info, path: im.path, bytes: im.bytes });
  }
  if (staged.length !== images.size) throw new ArchiveError(400, "Archivio non valido: immagini non elencate in assets.json.");

  return { manifest, campaign, members, scenes, tokens, fogs, walls, combats, groups, sheets, content, library, chat, images: staged, unpackedBytes: unpacked };
}

export function countsOf(a: StagedArchive): ArchiveCounts {
  return {
    members: a.members.length,
    scenes: a.scenes.length,
    tokens: a.tokens.length,
    walls: a.walls.length,
    fogs: a.fogs.length,
    combats: a.combats.length,
    groups: a.groups.length,
    sheets: a.sheets.length,
    content: a.content.length,
    library: a.library.length,
    chat: a.chat?.length ?? 0,
    assets: a.images.length,
  };
}

/** Ciò che l'admin vede prima di confermare. I conteggi sono quelli dei documenti letti, non quelli dichiarati. */
export function previewOf(a: StagedArchive): ImportPreview {
  return {
    campaignName: a.campaign.name,
    exportedAt: a.manifest.exportedAt,
    appVersion: a.manifest.appVersion,
    formatVersion: a.manifest.formatVersion,
    includesChat: a.manifest.includesChat,
    counts: countsOf(a),
    members: a.members,
    unpackedBytes: a.unpackedBytes,
    warnings: a.manifest.warnings,
  };
}

// ---------------------------------------------------------------------------
// Conferma: ricava lo stato con id nuovi e scrive tutto in una transazione
// ---------------------------------------------------------------------------

export interface Importer {
  id: string;
  name: string;
}

export interface CommitDeps {
  db: Db;
  config: AppConfig;
  /** Carica la stanza in tempo reale della nuova campagna dopo il salvataggio. */
  loadRoom(campaignId: string): Promise<void>;
}

const chunked = async <T>(rows: readonly T[], size: number, fn: (chunk: T[]) => Promise<unknown>): Promise<void> => {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
};

/**
 * Crea una NUOVA campagna dall'archivio (non ne sovrascrive mai una esistente).
 * - Tutti gli id (campagna, scene, token, muri, gruppi, schede, voci di chat, immagini) sono rigenerati;
 *   i file immagine ricevono un nome UUID nuovo.
 * - Membri: l'admin che importa è il GM; i giocatori dell'archivio diventano gli utenti scelti in
 *   `memberMap`. Un giocatore non associato perde ciò che gli apparteneva (token senza proprietario,
 *   scheda senza proprietario, maschera di nebbia) ma il resto resta.
 * - Tutto o niente: prima i file in `UPLOAD_DIR` (nomi nuovi, orfani se il resto fallisce e allora
 *   cancellati), poi una sola transazione SQLite.
 * - Epoca nuova e versione 0: i client collegati a un'altra campagna non sono toccati; chi apre la
 *   nuova riceve uno snapshot.
 */
export async function commitImport(
  deps: CommitDeps,
  importer: Importer,
  a: StagedArchive,
  rawOptions: unknown,
  dryRun = false,
): Promise<ImportResult> {
  const { db, config } = deps;
  const opts = ImportOptionsSchema.safeParse(rawOptions ?? {});
  if (!opts.success) throw issuesOf("options", opts.error);
  const options = opts.data;
  const now = new Date();
  const warnings: string[] = [...a.manifest.warnings];
  const warn = (w: string) => {
    if (!warnings.includes(w) && warnings.length < 200) warnings.push(w);
  };

  // --- Mappatura dei membri ---------------------------------------------------------------------------------------
  const roleOfRef = new Map(a.members.map((m) => [m.ref, m.role]));
  const wantedUsers = new Set<string>();
  const userOfRef = new Map<string, string>();
  for (const [ref, userId] of Object.entries(options.memberMap)) {
    const role = roleOfRef.get(ref);
    if (!role) throw new ArchiveError(400, "La mappatura dei membri cita un membro che non è nell'archivio.");
    if (userId === null) continue;
    if (role === "admin") throw new ArchiveError(400, "Il GM dell'archivio è sempre l'admin che importa: non va associato.");
    if (wantedUsers.has(userId)) throw new ArchiveError(400, "Due membri dell'archivio non possono corrispondere allo stesso utente.");
    wantedUsers.add(userId);
    userOfRef.set(ref, userId);
  }
  for (const m of a.members) if (m.role === "admin") userOfRef.set(m.ref, importer.id);
  const userRows = wantedUsers.size === 0 ? [] : await db.select({ id: userTable.id, name: userTable.name, role: userTable.role }).from(userTable).where(inArray(userTable.id, [...wantedUsers]));
  if (userRows.length !== wantedUsers.size) throw new ArchiveError(400, "Un utente scelto per la mappatura non esiste.");
  if (userRows.some((u) => u.role !== "player")) throw new ArchiveError(400, "Ai giocatori dell'archivio si possono associare solo utenti giocatori.");
  const unmappedPlayers = a.members.filter((m) => m.role === "player" && !userOfRef.has(m.ref));
  for (const m of unmappedPlayers) warn(`Il giocatore "${m.name}" non è associato a nessun utente: token, scheda e nebbia personale restano senza proprietario.`);

  // --- Id nuovi -------------------------------------------------------------------------------------------------------------
  const campaignId = randomUUID();
  const sceneIds = new Map(a.scenes.map((s) => [s.id, randomUUID()]));
  const tokenIds = new Map(a.tokens.map((t) => [t.id, randomUUID()]));
  const wallIds = new Map(a.walls.map((w) => [w.id, randomUUID()]));
  const groupIds = new Map(a.groups.map((g) => [g.id, randomUUID()]));
  const assetIds = new Map(a.images.map((i) => [i.meta.id, { id: randomUUID(), ext: i.info.ext }]));
  const need = <T>(m: ReadonlyMap<string, T>, k: string, what: string): T => {
    const v = m.get(k);
    if (v === undefined) throw new ArchiveError(400, `Archivio incoerente: ${what} fa riferimento a un oggetto inesistente.`);
    return v;
  };

  const remapUrl = (url: string | null): string | null => {
    if (url === null) return null;
    const p = parseAssetUrl(url);
    if (!p) return url; // URL esterno: resta com'è (come per i token già esistenti)
    const n = assetIds.get(p.id);
    if (!n) {
      warn("Alcune immagini citate non sono nell'archivio: sono state tolte.");
      return null;
    }
    return assetUrlOf(n.id, n.ext);
  };

  const refUser = (ref: string | null, what: string): string | null => {
    if (ref === null) return null;
    if (!roleOfRef.has(ref)) throw new ArchiveError(400, `Archivio incoerente: ${what} cita un membro sconosciuto.`);
    return userOfRef.get(ref) ?? null;
  };

  // --- Stato della nuova campagna ----------------------------------------------------------------------------------------------
  const members: Member[] = [
    { userId: importer.id, displayName: importer.name.trim().slice(0, 64) || "GM", role: "admin" },
    // Nell'ordine dell'archivio (non in quello, indefinito, della query).
    ...a.members.flatMap((m): Member[] => {
      const u = userRows.find((r) => r.id === userOfRef.get(m.ref));
      return m.role === "player" && u ? [{ userId: u.id, displayName: u.name.trim().slice(0, 64) || "?", role: "player" }] : [];
    }),
  ];
  const scenes = a.scenes.map((s) => {
    let map = s.map;
    if (map) {
      const n = assetIds.get(map.assetId);
      if (n) map = { assetId: n.id, url: assetUrlOf(n.id, n.ext) };
      else {
        warn("La mappa di una scena non è nell'archivio: la scena è stata importata senza mappa.");
        map = null;
      }
    }
    return { ...s, id: need(sceneIds, s.id, "scena"), map };
  });
  const tokens = a.tokens.map((t) => ({
    ...t,
    id: need(tokenIds, t.id, "token"),
    sceneId: need(sceneIds, t.sceneId, "token"),
    imageUrl: remapUrl(t.imageUrl),
    ownerUserId: refUser(t.ownerUserId, "un token"),
  }));
  const fogs = a.fogs.map((f) => {
    const seen = new Set<string>();
    const players = f.players
      .flatMap((p) => {
        const userId = refUser(p.userId, "la nebbia");
        // Solo giocatori associati (la maschera di un GM non esiste) e senza doppioni.
        if (userId === null || userId === importer.id || seen.has(userId)) return [];
        seen.add(userId);
        return [{ ...p, userId }];
      })
      .sort((x, y) => (x.userId < y.userId ? -1 : x.userId > y.userId ? 1 : 0));
    return { ...f, sceneId: need(sceneIds, f.sceneId, "nebbia"), players };
  });
  const walls = a.walls.map((w) => ({ ...w, id: need(wallIds, w.id, "muro"), sceneId: need(sceneIds, w.sceneId, "muro") }));
  const combats = a.combats.map((c) => ({
    ...c,
    sceneId: need(sceneIds, c.sceneId, "combattimento"),
    participants: c.participants.map((p) => ({ ...p, tokenId: p.tokenId === null ? null : need(tokenIds, p.tokenId, "combattimento") })),
  }));
  const groups = a.groups.map((g) => ({ ...g, id: need(groupIds, g.id, "gruppo"), tokenIds: g.tokenIds.map((t) => need(tokenIds, t, "gruppo")) }));
  const name = options.name ?? a.campaign.name;
  const stateParsed = CampaignStateSchema.safeParse({
    campaignId,
    name,
    version: 0,
    activeSceneId: a.campaign.activeSceneId === null ? null : (sceneIds.get(a.campaign.activeSceneId) ?? null),
    members,
    scenes,
    tokens,
    fogs,
    walls,
    combats,
    groups,
  });
  if (!stateParsed.success) throw issuesOf("stato", stateParsed.error);
  const problems = checkInvariants(stateParsed.data);
  if (problems.length > 0) throw new ArchiveError(400, "L'archivio descrive uno stato incoerente.", problems.slice(0, 5));
  const state: CampaignState = stateParsed.data;

  // --- Altre tabelle -----------------------------------------------------------------------------------------------------------
  // Una scheda ha come proprietario un giocatore (mai il GM che importa).
  const playerOwner = (ref: string | null): string | null => {
    const u = refUser(ref, "una scheda");
    return u === importer.id ? null : u;
  };
  const sheetRows = a.sheets.map((s, i) => ({
    createdAt: new Date(now.getTime() + i),
    id: randomUUID(),
    campaignId,
    kind: s.kind,
    ownerUserId: s.kind === "pc" ? playerOwner(s.ownerRef) : null,
    tokenId: s.tokenId === null ? null : (tokenIds.get(s.tokenId) ?? null),
    name: s.doc.sheet.name,
    data: JSON.stringify(s.doc),
  }));
  const contentMap = new Map<string, { key: string; kind: (typeof a.content)[number]["kind"]; name: string; data: string; source: string }>();
  for (const c of a.content) {
    const source = c.source ?? "";
    const key = keyOf(c.kind, c.name, source, campaignId);
    contentMap.set(key, { key, kind: c.kind, name: c.name, data: JSON.stringify(c.data), source });
  }
  const libraryRows = a.library.map((l, i) => ({
    createdAt: new Date(now.getTime() + i),
    id: randomUUID(),
    campaignId,
    name: l.name,
    kind: l.kind,
    data: JSON.stringify({ size: l.size, imageUrl: remapUrl(l.imageUrl), stats: l.stats, tags: l.tags }),
  }));
  let chatRows: { id: string; campaignId: string; kind: "message" | "roll"; authorId: string; visibility: "public" | "gm" | "whisper"; whisperTo: string | null; at: number; data: string }[] = [];
  if (options.includeChat) {
    if (!a.chat) warn("L'archivio non contiene la cronologia di chat e tiri.");
    else {
      // Gli autori non associati restano un riferimento opaco (`m3`): non coincide con nessun utente.
      const who = (ref: string): string => userOfRef.get(ref) ?? ref;
      chatRows = a.chat.map((e) => {
        const entry: ChatLogEntry = { ...e, id: randomUUID(), authorId: who(e.authorId), whisperTo: e.whisperTo === null ? null : who(e.whisperTo) };
        return { id: entry.id, campaignId, kind: entry.kind, authorId: entry.authorId, visibility: entry.visibility, whisperTo: entry.whisperTo, at: entry.at, data: JSON.stringify(entry) };
      });
    }
  }

  // --- Scrittura: prima i file (nomi nuovi), poi una transazione ------------------------------------------------------------------
  const counts = countsOf(a);
  counts.members = members.length;
  counts.chat = chatRows.length;
  counts.content = contentMap.size;
  // Anteprima: tutta la validazione e le rimappature sono fatte, ma non si scrive nulla.
  if (dryRun) return { campaign: { id: campaignId, name, createdAt: now.toISOString() }, counts, warnings };

  const root = resolve(config.uploadDir);
  await mkdir(root, { recursive: true });
  const moved: string[] = [];
  try {
    for (const img of a.images) {
      const n = assetIds.get(img.meta.id)!;
      const dest = join(root, `${n.id}.${n.ext}`);
      await rename(img.path, dest);
      moved.push(dest);
    }
    await db.transaction(async (tx) => {
      await tx.insert(campaignTable).values({
        id: campaignId,
        name,
        version: 0,
        epoch: randomUUID(),
        activeSceneId: state.activeSceneId,
        createdBy: importer.id,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(campaignMember).values(members.map((m, i) => ({ campaignId, userId: m.userId, createdAt: new Date(now.getTime() + i) })));
      for (const img of a.images) {
        const n = assetIds.get(img.meta.id)!;
        // La "kind" (mappa o token) non è dedotta dal contenuto: si usa quella dichiarata, che serve solo a classificare.
        await tx.insert(assetTable).values({
          id: n.id,
          kind: img.meta.kind,
          mime: img.info.mime,
          ext: img.info.ext,
          width: img.info.width,
          height: img.info.height,
          bytes: img.bytes,
          uploadedBy: importer.id,
        });
      }
      await chunked(state.scenes.map((s, i) => ({ campaignId, id: s.id, sort: i + 1, data: JSON.stringify(s) })), 200, (r) => tx.insert(sceneTable).values(r));
      await chunked(state.tokens.map((t, i) => ({ campaignId, id: t.id, sceneId: t.sceneId, sort: i + 1, data: JSON.stringify(t) })), 200, (r) => tx.insert(tokenTable).values(r));
      await chunked((state.fogs ?? []).map((f) => ({ campaignId, sceneId: f.sceneId, data: JSON.stringify(f) })), 100, (r) => tx.insert(fogTable).values(r));
      await chunked((state.walls ?? []).map((w, i) => ({ campaignId, id: w.id, sceneId: w.sceneId, sort: i + 1, data: JSON.stringify(w) })), 200, (r) => tx.insert(wallTable).values(r));
      await chunked((state.combats ?? []).map((c) => ({ campaignId, sceneId: c.sceneId, data: JSON.stringify(c) })), 100, (r) => tx.insert(combatTable).values(r));
      await chunked((state.groups ?? []).map((g, i) => ({ campaignId, id: g.id, sort: i + 1, data: JSON.stringify(g) })), 100, (r) => tx.insert(tokenGroup).values(r));
      await chunked(sheetRows, 100, (r) => tx.insert(characterSheet).values(r));
      await chunked([...contentMap.values()].map((c) => ({ id: randomUUID(), campaignId, ...c })), 100, (r) => tx.insert(contentTable).values(r));
      await chunked(libraryRows, 200, (r) => tx.insert(libraryItem).values(r));
      await chunked(chatRows, 200, (r) => tx.insert(chatEntry).values(r));
    });
  } catch (err) {
    await Promise.all(moved.map((p) => rm(p, { force: true })));
    throw err;
  }
  await deps.loadRoom(campaignId);
  return { campaign: { id: campaignId, name, createdAt: now.toISOString() }, counts, warnings };
}
