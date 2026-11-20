import type { SheetDoc, SheetSnapshot } from "./rules5e/doc.js";

/** API REST delle schede (server: packages/server/src/sheets). */

export type SheetKind = "pc" | "monster";

export interface SheetSummary extends SheetSnapshot {
  id: string;
  campaignId: string;
  kind: SheetKind;
  name: string;
  ownerUserId: string | null;
  /** Solo per il GM: il giocatore non riceve mai il legame con il token (potrebbe essere nascosto). */
  tokenId?: string | null;
  /** Cresce di 1 a ogni scrittura: serve al controllo di concorrenza. */
  version: number;
  updatedAt: string;
}

export interface SheetRecord extends SheetSummary {
  doc: SheetDoc;
}

export interface ListSheetsResponse {
  sheets: SheetSummary[];
}

export interface CreateSheetRequest {
  kind: SheetKind;
  doc: unknown;
  /** Solo GM (il giocatore crea sempre schede proprie). */
  ownerUserId?: string | null;
  /** Solo GM. */
  tokenId?: string | null;
}

export interface UpdateSheetRequest {
  /** Versione che il client ha letto: se non è più l'ultima la scrittura è rifiutata (409 CONFLICT). */
  version: number;
  doc?: unknown;
  /** Solo GM. */
  ownerUserId?: string | null;
  /** Solo GM. */
  tokenId?: string | null;
}
