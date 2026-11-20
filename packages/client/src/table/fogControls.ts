import { useMemo, useState } from "react";
import type { ToolState } from "../map";

/**
 * Stato dell'interfaccia della nebbia (solo locale, mai inviato): destinatari dei pennelli, "vista come",
 * velo, vista dei token, muri, strumento attivo e muro selezionato.
 */
export interface FogControls {
  /** Giocatori scelti come destinatari; vuoto = tutti. */
  target: readonly string[];
  setTarget: (ids: readonly string[]) => void;
  /** GM: maschera controllata sul velo (`null` = "tutti"). */
  viewAs: string | null;
  setViewAs: (id: string | null) => void;
  /** GM: mostra il velo in trasparenza. */
  veil: boolean;
  setVeil: (v: boolean) => void;
  /** Aiuto visivo della vista dei token. */
  sight: boolean;
  setSight: (v: boolean) => void;
  /** Mostra i muri. */
  walls: boolean;
  setWalls: (v: boolean) => void;
  tool: ToolState;
  setTool: (s: ToolState) => void;
  selectedWall: string | null;
  setSelectedWall: (id: string | null) => void;
}

export const INITIAL_TOOL: ToolState = { tool: "select", fogBrush: "rect", fogMode: "reveal", wallMode: "draw" };

export function useFogControls(): FogControls {
  const [target, setTarget] = useState<readonly string[]>([]);
  const [viewAs, setViewAs] = useState<string | null>(null);
  const [veil, setVeil] = useState(true);
  const [sight, setSight] = useState(false);
  const [walls, setWalls] = useState(true);
  const [tool, setTool] = useState<ToolState>(INITIAL_TOOL);
  const [selectedWall, setSelectedWall] = useState<string | null>(null);
  return useMemo(
    () => ({ target, setTarget, viewAs, setViewAs, veil, setVeil, sight, setSight, walls, setWalls, tool, setTool, selectedWall, setSelectedWall }),
    [target, viewAs, veil, sight, walls, tool, selectedWall]
  );
}

/** Destinatari ancora validi: chi ha lasciato la campagna (o non e' piu' giocatore) sparisce dalla scelta. */
export function validTargets(target: readonly string[], playerIds: readonly string[]): string[] {
  return target.filter((id) => playerIds.includes(id));
}

/** Aggiunge o toglie un giocatore dai destinatari (l'ordine segue quello dei giocatori). */
export function toggleTarget(target: readonly string[], userId: string, playerIds: readonly string[]): string[] {
  const set = new Set(target);
  if (set.has(userId)) set.delete(userId);
  else set.add(userId);
  return playerIds.filter((id) => set.has(id));
}
