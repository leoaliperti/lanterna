import { z } from "zod";
import { LogEntrySchema } from "./protocol/chat.js";
import { LibraryContentSchema } from "./library.js";
import { TokenKindSchema, NameSchema, RoleSchema } from "./state/schema.js";
import { LIMITS } from "./state/limits.js";
import type { CampaignSummary } from "./api.js";

/**
 * Esportazione e importazione di una campagna (M10).
 *
 * L'archivio è un `.zip` di sola struttura: nessun percorso viene mai usato dal disco (solo nomi
 * fissi ammessi, vedi `ARCHIVE_JSON_FILES` e `assetEntryName`). Contiene `manifest.json` (versione del
 * formato, data, versione dell'app, elenco dei file con dimensione e SHA-256) e un documento JSON per
 * categoria, più le immagini in `assets/`.
 *
 * Privacy: gli utenti NON sono esportati. `members.json` ha solo nome e ruolo, con un riferimento
 * opaco (`m1`, `m2`, ...) che sostituisce ogni id utente nei documenti (proprietari dei token, schede,
 * maschere di nebbia, autori della chat). All'importazione l'admin associa i riferimenti ai propri utenti.
 * Mai inclusi: email, password o hash, sessioni, segreti del server.
 */

export const ARCHIVE_FORMAT = "lanterna-campaign";
/** Cresce quando il formato cambia in modo non compatibile. L'importazione rifiuta versioni più nuove. */
export const ARCHIVE_FORMAT_VERSION = 2;

/** File JSON ammessi nell'archivio (oltre a `assets/<uuid>.<ext>`). */
export const ARCHIVE_JSON_FILES = [
  "manifest.json",
  "campaign.json",
  "members.json",
  "scenes.json",
  "tokens.json",
  "fog.json",
  "walls.json",
  /** Dalla versione 2; facoltativo (gli archivi della versione 1 non lo hanno). */
  "props.json",
  "combats.json",
  "groups.json",
  "sheets.json",
  "content.json",
  "library.json",
  "chat.json",
  "assets.json",
] as const;
export type ArchiveJsonFile = (typeof ARCHIVE_JSON_FILES)[number];

export const ARCHIVE_ASSET_ENTRY = /^assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|jpg|webp)$/;

export const assetEntryName = (id: string, ext: string): string => `assets/${id}.${ext}`;

/** Riferimento opaco a un membro (`m1`) o, solo nella chat, a un autore non più membro (`x1`). */
export const MemberRefSchema = z.string().regex(/^[mx][0-9]{1,6}$/, "riferimento non valido");

export const ARCHIVE_LIMITS = {
  /** Voci di chat/tiri importabili. */
  maxChatEntries: 100_000,
  maxMembers: 256,
  maxSheets: 2000,
  maxContent: 5000,
  maxAssets: 4000,
  /** File elencati nel manifesto (documenti + immagini). */
  maxFiles: 4100,
} as const;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const isoDate = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "data non valida");

export const ArchiveCountsSchema = z.strictObject({
  members: z.number().int().min(0),
  scenes: z.number().int().min(0),
  tokens: z.number().int().min(0),
  walls: z.number().int().min(0),
  /** Dalla versione 2 (assente negli archivi vecchi). */
  props: z.number().int().min(0).optional(),
  fogs: z.number().int().min(0),
  combats: z.number().int().min(0),
  groups: z.number().int().min(0),
  sheets: z.number().int().min(0),
  content: z.number().int().min(0),
  library: z.number().int().min(0),
  chat: z.number().int().min(0),
  assets: z.number().int().min(0),
});
export type ArchiveCounts = z.infer<typeof ArchiveCountsSchema>;

export const ManifestSchema = z.strictObject({
  format: z.literal(ARCHIVE_FORMAT),
  formatVersion: z.number().int().min(1),
  exportedAt: isoDate,
  /** Versione dell'app che ha esportato. */
  appVersion: z.string().max(32),
  /** Versione del protocollo WebSocket dell'app che ha esportato (informativa). */
  protocolVersion: z.number().int().min(1),
  campaignName: NameSchema,
  includesChat: z.boolean(),
  counts: ArchiveCountsSchema,
  /** Tutti i file dell'archivio tranne il manifesto: dimensione e SHA-256 (verificati all'importazione). */
  files: z
    .array(z.strictObject({ path: z.string().max(120), bytes: z.number().int().min(0), sha256 }))
    .max(ARCHIVE_LIMITS.maxFiles),
  /** Avvisi dell'esportazione (es. immagine mancante sul disco). */
  warnings: z.array(z.string().max(300)).max(100),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const ArchiveCampaignSchema = z.strictObject({
  name: NameSchema,
  /** Scena attiva al momento dell'esportazione (id nel documento `scenes.json`). */
  activeSceneId: z.string().max(LIMITS.idMaxLength).nullable(),
});

export const ArchiveMemberSchema = z.strictObject({ ref: MemberRefSchema, name: NameSchema, role: RoleSchema });
export type ArchiveMember = z.infer<typeof ArchiveMemberSchema>;

export const ArchiveAssetSchema = z.strictObject({
  id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  kind: z.enum(["map", "token"]),
  mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
  ext: z.enum(["png", "jpg", "webp"]),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  bytes: z.number().int().min(1),
});
export type ArchiveAsset = z.infer<typeof ArchiveAssetSchema>;

/** Scheda: `doc` si valida con lo schema delle schede (`sheetDocSchema`) all'importazione. */
export const ArchiveSheetSchema = z.strictObject({
  kind: z.enum(["pc", "monster"]),
  ownerRef: MemberRefSchema.nullable(),
  /** Id del token collegato (nel documento `tokens.json`), se esiste ancora. */
  tokenId: z.string().max(LIMITS.idMaxLength).nullable(),
  doc: z.unknown(),
});
export type ArchiveSheet = z.infer<typeof ArchiveSheetSchema>;

export const ArchiveContentSchema = z.strictObject({
  kind: z.enum(["monster", "item", "spell", "class", "species", "note", "altro"]),
  name: z.string().min(1).max(200),
  source: z.string().max(200),
  data: z.record(z.string(), z.unknown()),
});
export type ArchiveContent = z.infer<typeof ArchiveContentSchema>;

export const ArchiveLibraryItemSchema = z.strictObject({
  name: NameSchema,
  kind: TokenKindSchema,
  ...LibraryContentSchema.shape,
});
export type ArchiveLibraryItem = z.infer<typeof ArchiveLibraryItemSchema>;

/** Voce di chat o tiro con `authorId` e `whisperTo` espressi come riferimenti ai membri. */
export const ArchiveChatEntrySchema = LogEntrySchema;

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

/** Cosa contiene un archivio, mostrato all'admin prima di confermare (`POST /campaigns/import?preview=1`). */
export interface ImportPreview {
  campaignName: string;
  exportedAt: string;
  appVersion: string;
  formatVersion: number;
  includesChat: boolean;
  counts: ArchiveCounts;
  /** Membri dell'archivio (solo nome e ruolo): l'admin li associa ai propri utenti. */
  members: ArchiveMember[];
  /** Byte totali (non compressi) dell'archivio. */
  unpackedBytes: number;
  warnings: string[];
}

/** Opzioni dell'importazione (campo `options` del multipart, JSON). */
export const ImportOptionsSchema = z.strictObject({
  /** Nome della nuova campagna (default: quello dell'archivio). */
  name: NameSchema.optional(),
  /** Riferimento del membro -> id di un utente esistente (giocatori), `null` = non associato. */
  memberMap: z.record(MemberRefSchema, z.string().min(1).max(LIMITS.idMaxLength).regex(/^[A-Za-z0-9_-]+$/).nullable()).default({}),
  /** Importa anche chat e tiri (se l'archivio li contiene). */
  includeChat: z.boolean().default(false),
});
export type ImportOptions = z.input<typeof ImportOptionsSchema>;

/** Risposta di `POST /campaigns/import`. */
export interface ImportResult {
  campaign: CampaignSummary;
  counts: ArchiveCounts;
  warnings: string[];
}
