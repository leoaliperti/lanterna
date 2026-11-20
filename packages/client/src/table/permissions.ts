import type { CampaignView, TokenView } from "@lanterna/shared";

/**
 * Permessi "di UX": decidono solo quali pulsanti mostrare. La sicurezza e' sul server, che rifiuta
 * comunque (FORBIDDEN) cio' che il client lasciasse passare. Specchiano la tabella di docs/PROTOCOL.md.
 */
export interface UxPermissions {
  isGm: boolean;
  /** Scene, mappa, griglia, creare/eliminare token. */
  canManageScenes: boolean;
  canCreateTokens: boolean;
  canSeeGmNotes: boolean;
  canMoveToken(token: TokenView): boolean;
  /** Apre l'editor: il GM per intero, il proprietario solo per le condizioni. */
  canOpenEditor(token: TokenView): boolean;
  /** Campi dell'editor che l'utente puo' modificare. */
  canEditFields(token: TokenView): { all: boolean; conditions: boolean };
  /** Annulla/ripeti: il server limita il giocatore alle proprie azioni, il GM puo' tutto. */
  canUndoRedo: boolean;
}

export function permissionsFor(view: CampaignView): UxPermissions {
  const isGm = view.viewer.role === "admin";
  const owns = (t: TokenView) => t.ownerUserId !== null && t.ownerUserId === view.viewer.userId;
  return {
    isGm,
    canManageScenes: isGm,
    canCreateTokens: isGm,
    canSeeGmNotes: isGm,
    canMoveToken: (t) => isGm || owns(t),
    canOpenEditor: (t) => isGm || owns(t),
    canEditFields: (t) => ({ all: isGm, conditions: isGm || owns(t) }),
    canUndoRedo: true
  };
}
