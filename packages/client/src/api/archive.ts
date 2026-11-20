import type { CampaignSummary, ImportOptions, ImportPreview, ImportResult, ListCampaignsResponse } from "@lanterna/shared";
import { ApiRequestError, request } from "./client";

/**
 * Esportazione e importazione di campagne (REST `GET /campaigns/:id/export`, `POST /campaigns/import`).
 * Solo admin: il server risponde 403 a chiunque altro. Il file dell'archivio non passa mai da `fetch` con
 * un corpo JSON: si invia come multipart con `XMLHttpRequest` per avere l'avanzamento del caricamento.
 */

const BASE = "/api";

/** Tutte le campagne (solo admin, a differenza di `/campaigns/mine`). */
export async function listAllCampaigns(): Promise<CampaignSummary[]> {
  return (await request<ListCampaignsResponse>("GET", "/campaigns")).campaigns;
}

/** URL da cui il browser scarica lo zip (stessa origine: i cookie di sessione partono da soli). */
export function exportUrl(campaignId: string, includeChat: boolean): string {
  return `${BASE}/campaigns/${encodeURIComponent(campaignId)}/export${includeChat ? "?chat=true" : ""}`;
}

/** Avvia il download senza lasciare la pagina. */
export function downloadExport(campaignId: string, includeChat: boolean): void {
  const a = document.createElement("a");
  a.href = exportUrl(campaignId, includeChat);
  a.download = "";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

interface PostArchiveOptions {
  file: File;
  options?: ImportOptions;
  preview: boolean;
  /** 0..1 durante il caricamento; `null` quando il file e' arrivato e il server sta elaborando. */
  onProgress?: (ratio: number | null) => void;
  signal?: AbortSignal;
}

function postArchive<T>({ file, options, preview, onProgress, signal }: PostArchiveOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const form = new FormData();
    // `options` prima del file: il server legge il flusso in ordine.
    if (options && !preview) form.append("options", JSON.stringify(options));
    form.append("file", file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}/campaigns/import${preview ? "?preview=true" : ""}`);
    xhr.withCredentials = true;
    xhr.responseType = "text";
    xhr.setRequestHeader("accept", "application/json");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(Math.min(1, e.loaded / e.total));
    };
    xhr.upload.onload = () => onProgress?.(null);
    xhr.onerror = () => reject(new ApiRequestError(0, "Impossibile raggiungere il server. Controlla la connessione e riprova."));
    xhr.onabort = () => reject(new ApiRequestError(0, "Operazione annullata."));
    xhr.onload = () => {
      let data: unknown;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && data) {
        resolve(data as T);
        return;
      }
      const body = (data ?? {}) as { error?: string; details?: unknown };
      const details = Array.isArray(body.details) ? body.details.filter((d): d is string => typeof d === "string") : [];
      const base = body.error ?? "Qualcosa è andato storto. Riprova.";
      reject(new ApiRequestError(xhr.status, details.length > 0 ? `${base} ${details.join(" · ")}` : base));
    };
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

/** Valida l'archivio e ne mostra il contenuto, senza creare nulla. */
export function previewArchive(file: File, onProgress?: (ratio: number | null) => void, signal?: AbortSignal): Promise<ImportPreview> {
  return postArchive<ImportPreview>({ file, preview: true, onProgress, signal });
}

/** Crea una NUOVA campagna dall'archivio. */
export function importArchive(file: File, options: ImportOptions, onProgress?: (ratio: number | null) => void, signal?: AbortSignal): Promise<ImportResult> {
  return postArchive<ImportResult>({ file, options, preview: false, onProgress, signal });
}

/** Messaggio leggibile: i messaggi del server sono gia' in italiano e dicono cosa non va nell'archivio. */
export function archiveErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 0) return err.message;
    if (err.status === 403) return "Solo il GM può esportare o importare campagne.";
    if (err.status === 429) return err.message.includes("in corso") ? err.message : "Troppe richieste. Attendi un minuto e riprova.";
    if (err.status >= 500) return "Il server ha avuto un problema e non ha creato nulla. Riprova fra poco.";
    return err.message;
  }
  return "Qualcosa è andato storto. Riprova.";
}
