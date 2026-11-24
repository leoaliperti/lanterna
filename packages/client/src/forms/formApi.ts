import type { FormTemplateResponse, SaveFormTemplateRequest } from "@lanterna/shared";
import { ApiRequestError, request } from "../api/client";
import { API_BASE } from "../realtime/urls";

/** Modulo sopra il PDF del GM (REST). Permessi e validazione stanno sul server. */

const base = (campaignId: string) => `/campaigns/${encodeURIComponent(campaignId)}/form`;

export function getForm(campaignId: string): Promise<FormTemplateResponse> {
  return request("GET", base(campaignId));
}

export function saveForm(campaignId: string, body: SaveFormTemplateRequest): Promise<FormTemplateResponse> {
  return request("PUT", base(campaignId), { body });
}

export async function deleteForm(campaignId: string): Promise<void> {
  await request("DELETE", base(campaignId));
}

/** URL del PDF per il visualizzatore (il cookie di sessione è inviato con `withCredentials`). */
export function formPdfUrl(campaignId: string): string {
  return `${API_BASE}${base(campaignId)}/pdf`;
}

export interface UploadedForm extends FormTemplateResponse {
  droppedFields?: number;
}

/** Carica il PDF del GM. Il server ne verifica i byte e il numero di pagine. */
export async function uploadFormPdf(campaignId: string, file: File): Promise<UploadedForm> {
  const form = new FormData();
  form.append("file", file);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${base(campaignId)}/pdf`, { method: "POST", credentials: "include", body: form });
  } catch {
    throw new ApiRequestError(0, "Impossibile raggiungere il server. Controlla la connessione e riprova.");
  }
  const data = (await response.json().catch(() => null)) as (Partial<UploadedForm> & { error?: string }) | null;
  if (!response.ok || !data || !data.template) {
    throw new ApiRequestError(response.status, data?.error ?? "Caricamento del PDF non riuscito.");
  }
  return data as UploadedForm;
}
