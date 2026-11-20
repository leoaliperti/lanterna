import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { EntryVisibility, UserRole } from "@lanterna/shared";

// Tabelle richieste da Better Auth (user, session, account, verification) più il campo `role`.
// Le chiavi TypeScript devono coincidere con i nomi dei campi di Better Auth.

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
};

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  role: text("role").$type<UserRole>().notNull().default("player"),
  ...timestamps,
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ...timestamps,
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// ---------------------------------------------------------------------------
// Campagne (M2/M3). Scene e token sono salvati come JSON (`data`) e validati
// con gli schemi Zod di @lanterna/shared a ogni lettura: il modello vive in un
// solo posto e il database non può introdurre campi o valori non ammessi.
// ---------------------------------------------------------------------------

export const campaign = sqliteTable("campaign", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Versione dello stato: cresce di 1 per ogni comando applicato. */
  version: integer("version").notNull().default(0),
  /** Linea dello stato: cambia quando lo stato viene riscritto fuori dai comandi (membri, ripristino). */
  epoch: text("epoch").notNull(),
  activeSceneId: text("active_scene_id"),
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
});

/** Membri di una campagna. Il ruolo nella campagna è quello dell'account (admin = GM). */
export const campaignMember = sqliteTable(
  "campaign_member",
  {
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaign.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamps.createdAt,
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.userId] }), index("campaign_member_user_idx").on(t.userId)],
);

export const scene = sqliteTable(
  "scene",
  {
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaign.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    /** Ordine di creazione (crescente). */
    sort: integer("sort").notNull(),
    /** `Scene` completa in JSON, validata con `SceneSchema` in lettura. */
    data: text("data").notNull(),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.id] })],
);

export const token = sqliteTable(
  "token",
  {
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaign.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    sceneId: text("scene_id").notNull(),
    /** Ordine di disegno (z-order), crescente. */
    sort: integer("sort").notNull(),
    /** `Token` completo in JSON, validato con `TokenSchema` in lettura. */
    data: text("data").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.campaignId, t.id] }),
    index("token_scene_idx").on(t.campaignId, t.sceneId),
  ],
);

/**
 * Nebbia di guerra (M6): una riga per scena con nebbia, `data` = `Fog` in JSON (maschere per
 * giocatore comprese), validata con `FogSchema` in lettura. Nessuna riga = nessuna nebbia.
 */
export const fog = sqliteTable(
  "fog",
  {
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaign.id, { onDelete: "cascade" }),
    sceneId: text("scene_id").notNull(),
    data: text("data").notNull(),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.sceneId] })],
);

/** Muri e porte (M6): una riga per muro, `data` = `Wall` in JSON validato con `WallSchema`. */
export const wall = sqliteTable(
  "wall",
  {
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaign.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    sceneId: text("scene_id").notNull(),
    /** Ordine di creazione (crescente). */
    sort: integer("sort").notNull(),
    data: text("data").notNull(),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.id] }), index("wall_scene_idx").on(t.campaignId, t.sceneId)],
);

/** Combattimento di una scena (M7): una riga per scena, `data` = `Combat` in JSON validato con `CombatSchema`. */
export const combat = sqliteTable(
  "combat",
  {
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaign.id, { onDelete: "cascade" }),
    sceneId: text("scene_id").notNull(),
    data: text("data").notNull(),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.sceneId] })],
);

/** Gruppi salvati di token (M7): una riga per gruppo, `data` = `TokenGroup` in JSON validato con `GroupSchema`. */
export const tokenGroup = sqliteTable(
  "token_group",
  {
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaign.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    /** Ordine di creazione (crescente). */
    sort: integer("sort").notNull(),
    data: text("data").notNull(),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.id] })],
);

/** Registro dei cambiamenti per versione (riconnessione con delta anche dopo un riavvio). */
export const campaignEvent = sqliteTable(
  "campaign_event",
  {
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaign.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** `StateChange[]` in JSON (contiene dati segreti: mai inviato così ai client). */
    changes: text("changes").notNull(),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.version] })],
);

/** File caricati (mappe e immagini dei token). Il file sta in `UPLOAD_DIR/<id>.<ext>`. */
export const asset = sqliteTable("asset", {
  id: text("id").primaryKey(),
  kind: text("kind").$type<"map" | "token">().notNull(),
  mime: text("mime").$type<"image/png" | "image/jpeg" | "image/webp">().notNull(),
  ext: text("ext").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  bytes: integer("bytes").notNull(),
  uploadedBy: text("uploaded_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamps.createdAt,
});

/**
 * Log di sessione (M4): messaggi di chat e tiri, nell'ordine di `seq`. La voce completa sta in
 * `data` (JSON validato con `LogEntrySchema` in lettura); visibilità, autore e destinatario sono
 * anche colonne per filtrare in SQL. Autore e destinatario non sono chiavi esterne: il log resta
 * intatto anche se un utente viene eliminato. `seq` non esce mai dal server (il cursore è `id`).
 */
export const chatEntry = sqliteTable(
  "chat_entry",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaign.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"message" | "roll">().notNull(),
    authorId: text("author_id").notNull(),
    visibility: text("visibility").$type<EntryVisibility>().notNull(),
    whisperTo: text("whisper_to"),
    /** Millisecondi dall'epoca Unix. */
    at: integer("at").notNull(),
    data: text("data").notNull(),
  },
  (t) => [index("chat_entry_campaign_seq_idx").on(t.campaignId, t.seq)],
);

/**
 * Contenuti di gioco importati nell'istanza (M5): mostri, oggetti, incantesimi, ... Mai nel repo.
 * `data` è JSON arbitrario ma validato in ingresso (profondità, dimensione, niente HTML).
 * `key` = SHA-256 di (kind, nome minuscolo, source, campagna): rende l'importazione idempotente.
 */
export const content = sqliteTable(
  "content",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull().unique(),
    kind: text("kind").$type<"monster" | "item" | "spell" | "class" | "species" | "note" | "altro">().notNull(),
    name: text("name").notNull(),
    data: text("data").notNull(),
    source: text("source").notNull().default(""),
    campaignId: text("campaign_id").references(() => campaign.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [index("content_kind_name_idx").on(t.kind, t.name), index("content_campaign_idx").on(t.campaignId)],
);

/**
 * Schede personaggio e statblock (M8). `data` = `SheetDoc` (scheda di regole + extra) in JSON, validato
 * con `sheetDocSchema` a ogni lettura e scrittura. `name` è una copia di `data.sheet.name` per l'elenco.
 * `ownerUserId`: giocatore proprietario (solo schede `pc`). `tokenId`: legame opzionale con un token
 * (non è una chiave esterna: i token stanno in una tabella con chiave composta e si cancellano con i comandi).
 * `version` cresce a ogni scrittura: l'aggiornamento è condizionato alla versione letta (concorrenza).
 */
export const characterSheet = sqliteTable(
  "character_sheet",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaign.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"pc" | "monster">().notNull(),
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "set null" }),
    tokenId: text("token_id"),
    name: text("name").notNull(),
    data: text("data").notNull(),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    index("character_sheet_campaign_idx").on(t.campaignId),
    index("character_sheet_owner_idx").on(t.campaignId, t.ownerUserId),
  ],
);

export const schema = {
  user,
  session,
  account,
  verification,
  campaign,
  campaignMember,
  scene,
  token,
  fog,
  wall,
  combat,
  tokenGroup,
  campaignEvent,
  asset,
  chatEntry,
  content,
  characterSheet,
};
