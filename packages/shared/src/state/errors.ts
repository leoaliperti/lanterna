import { z } from "zod";

/**
 * Codici d'errore di un comando.
 * - FORBIDDEN: l'attore vede l'oggetto ma non ha il permesso.
 * - INVALID: forma o valori non validi (coordinate fuori mappa, campi sconosciuti, ...).
 * - CONFLICT: id già esistente o stato cambiato nel frattempo (annulla/ripeti).
 * - NOT_FOUND: l'oggetto non esiste **oppure l'attore non può vederlo**.
 *   Per un giocatore un token nascosto e un token inesistente danno lo stesso errore,
 *   con lo stesso messaggio: l'errore non deve rivelarne l'esistenza.
 * - RATE_LIMITED: troppi messaggi di chat o tiri in poco tempo (mai prodotto dai comandi).
 */
export const ErrorCodeSchema = z.enum(["FORBIDDEN", "INVALID", "CONFLICT", "NOT_FOUND", "RATE_LIMITED"]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export interface CommandError {
  code: ErrorCode;
  message: string;
}

export function err(code: ErrorCode, message: string): { ok: false; error: CommandError } {
  return { ok: false, error: { code, message } };
}

/** Messaggi fissi: non includono mai id o dati presi dallo stato. */
export const MESSAGES = {
  tokenNotFound: "token non trovato",
  sceneNotFound: "scena non trovata",
  gmOnly: "azione riservata al GM",
  notOwner: "puoi agire solo sui tuoi token",
  fieldForbidden: "campo modificabile solo dal GM",
  outOfBounds: "posizione fuori dalla mappa",
  invalidCommand: "comando non valido",
  duplicateId: "id già in uso",
  unknownOwner: "proprietario non membro della campagna",
  tooMany: "limite raggiunto",
  nothingToUndo: "niente da annullare",
  nothingToRedo: "niente da ripetere",
  stale: "lo stato è cambiato nel frattempo",
} as const;
