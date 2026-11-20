import type {
  CreateSheetRequest,
  ListSheetsResponse,
  SheetRecord,
  SheetSummary,
  UpdateSheetRequest
} from "@lanterna/shared";
import { ApiRequestError, request } from "../api/client";

/** Chiamate REST delle schede e della libreria importata. Tutti i permessi sono verificati dal server. */

const base = (campaignId: string) => `/campaigns/${encodeURIComponent(campaignId)}/sheets`;

export async function listSheets(campaignId: string): Promise<SheetSummary[]> {
  const body = await request<Partial<ListSheetsResponse> | null>("GET", base(campaignId));
  return Array.isArray(body?.sheets) ? body.sheets : [];
}

export function getSheet(campaignId: string, sheetId: string): Promise<SheetRecord> {
  return request("GET", `${base(campaignId)}/${encodeURIComponent(sheetId)}`);
}

export function createSheet(campaignId: string, body: CreateSheetRequest): Promise<SheetRecord> {
  return request("POST", base(campaignId), { body });
}

export function saveSheet(campaignId: string, sheetId: string, body: UpdateSheetRequest): Promise<SheetRecord> {
  return request("PUT", `${base(campaignId)}/${encodeURIComponent(sheetId)}`, { body });
}

export async function deleteSheet(campaignId: string, sheetId: string): Promise<void> {
  await request("DELETE", `${base(campaignId)}/${encodeURIComponent(sheetId)}`);
}

export type LibraryKind = "monster" | "item" | "spell";

export interface LibraryHit {
  id: string;
  kind: string;
  name: string;
  source: string;
}

export interface LibraryDoc extends LibraryHit {
  data: Record<string, unknown>;
}

/** Cerca nei contenuti importati (`GET /content?kind=&q=`): il server filtra per ruolo (i mostri solo al GM). */
export async function searchLibrary(kind: LibraryKind, q: string): Promise<LibraryHit[]> {
  const params = new URLSearchParams({ kind, limit: "20" });
  if (q.trim()) params.set("q", q.trim().slice(0, 100));
  return (await request<{ items: LibraryHit[] }>("GET", `/content?${params.toString()}`)).items;
}

export function getLibraryDoc(id: string): Promise<LibraryDoc> {
  return request("GET", `/content/${encodeURIComponent(id)}`);
}

export function isConflict(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 409 && err.code === "CONFLICT";
}

/** Messaggio leggibile per un errore delle schede. */
export function sheetErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 0) return err.message;
    if (err.status === 403) return "Non hai il permesso di farlo.";
    if (err.status === 404) return "La scheda non esiste piu' o non e' disponibile.";
    if (err.status === 409) return err.code === "CONFLICT" ? "La scheda e' stata modificata altrove." : err.message;
    if (err.status === 400) return "I dati della scheda non sono validi.";
    if (err.status === 429) return "Troppe richieste. Attendi qualche secondo e riprova.";
    if (err.status >= 500) return "Il server ha avuto un problema. Riprova fra poco.";
    return err.message;
  }
  return "Qualcosa e' andato storto. Riprova.";
}
