import type {
  CreateLibraryItem,
  LibraryItem,
  LibraryItemPublic,
  ListLibraryResponse,
  TokenKind,
  UpdateLibraryItem
} from "@lanterna/shared";
import { request } from "../api/client";

/** Libreria di token e oggetti (REST `/library`, vedi docs/PROTOCOL.md). Il server verifica sempre i ruoli. */

export interface LibraryQuery {
  campaignId: string;
  q?: string;
  kind?: TokenKind | "all";
  limit?: number;
  offset?: number;
}

export function libraryPath(query: LibraryQuery): string {
  const params = new URLSearchParams({ campaignId: query.campaignId });
  const q = query.q?.trim();
  if (q) params.set("q", q);
  if (query.kind && query.kind !== "all") params.set("kind", query.kind);
  params.set("limit", String(query.limit ?? 50));
  if (query.offset) params.set("offset", String(query.offset));
  return `/library?${params.toString()}`;
}

/** L'admin riceve `LibraryItem` completi, il giocatore `LibraryItemPublic` (senza statistiche). */
export async function listLibrary(query: LibraryQuery): Promise<ListLibraryResponse> {
  const res = await request<Partial<ListLibraryResponse> | null>("GET", libraryPath(query));
  return { items: Array.isArray(res?.items) ? res.items : [], total: typeof res?.total === "number" ? res.total : 0 };
}

export function createLibraryItem(input: CreateLibraryItem): Promise<LibraryItem> {
  return request("POST", "/library", { body: input });
}

export function updateLibraryItem(id: string, patch: UpdateLibraryItem): Promise<LibraryItem> {
  return request("PATCH", `/library/${encodeURIComponent(id)}`, { body: patch });
}

export async function deleteLibraryItem(id: string): Promise<void> {
  await request("DELETE", `/library/${encodeURIComponent(id)}`);
}

export type AnyLibraryItem = LibraryItem | LibraryItemPublic;

/** Le statistiche ci sono solo nella vista dell'admin. */
export const hasStats = (item: AnyLibraryItem): item is LibraryItem => "stats" in item;
