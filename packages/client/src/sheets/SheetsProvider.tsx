import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SheetRecord, SheetSummary } from "@lanterna/shared";
import type { SessionUser } from "../api/client";
import { useCommands, useRealtimeState } from "../realtime/RealtimeProvider";
import { listSheets, sheetErrorMessage } from "./sheetsApi";
import { planTokenSync } from "./sheetLogic";

const POLL_MS = 8000;

export interface SheetsContextValue {
  campaignId: string;
  user: SessionUser;
  isGm: boolean;
  sheets: SheetSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Aggiorna l'elenco con una scheda appena salvata o creata. */
  upsert: (record: SheetRecord | SheetSummary) => void;
  remove: (sheetId: string) => void;
  /** Schede aperte (ordine di apertura) e quella in primo piano. */
  openIds: string[];
  activeId: string | null;
  /** Seconda scheda affiancata (solo schermi larghi). */
  sideId: string | null;
  workspaceOpen: boolean;
  open: (sheetId: string) => void;
  close: (sheetId: string) => void;
  activate: (sheetId: string) => void;
  setSide: (sheetId: string | null) => void;
  setWorkspaceOpen: (open: boolean) => void;
}

const Context = createContext<SheetsContextValue | null>(null);

export function useSheets(): SheetsContextValue {
  const v = useContext(Context);
  if (!v) throw new Error("useSheets va usato dentro <SheetsProvider>");
  return v;
}

export interface SheetsProviderProps {
  campaignId: string;
  user: SessionUser;
  children: ReactNode;
  /**
   * Sincronizza PF e condizioni scheda -> token (solo GM). Default `true`. Le finestre secondarie (M9) la
   * spengono: la fa solo la finestra del tavolo, così più finestre dello stesso GM non inviano comandi doppi.
   */
  syncTokens?: boolean;
}

/**
 * Elenco delle schede visibili all'utente (il server filtra: il giocatore riceve solo le proprie), schede aperte
 * e, per il GM, la sincronizzazione dei PF e delle condizioni dalla scheda al token collegato (vedi `planTokenSync`).
 */
export function SheetsProvider({ campaignId, user, children, syncTokens = true }: SheetsProviderProps) {
  const isGm = user.role === "admin";
  const [sheets, setSheets] = useState<SheetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sideId, setSideId] = useState<string | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await listSheets(campaignId);
      if (!mounted.current) return;
      setSheets(next);
      setError(null);
      // Schede sparite (eliminate o non più visibili): si chiudono.
      const ids = new Set(next.map((s) => s.id));
      setOpenIds((o) => o.filter((id) => ids.has(id)));
      setActiveId((a) => (a && !ids.has(a) ? null : a));
      setSideId((a) => (a && !ids.has(a) ? null : a));
    } catch (err) {
      if (mounted.current) setError(sheetErrorMessage(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const upsert = useCallback((record: SheetRecord | SheetSummary) => {
    // Si tiene solo il riepilogo (il documento completo non serve all'elenco).
    const { doc: _doc, ...summary } = record as SheetRecord;
    void _doc;
    setSheets((list) => {
      const i = list.findIndex((s) => s.id === summary.id);
      if (i < 0) return [...list, summary];
      const copy = [...list];
      copy[i] = summary;
      return copy;
    });
  }, []);

  const remove = useCallback((sheetId: string) => {
    setSheets((list) => list.filter((s) => s.id !== sheetId));
    setOpenIds((o) => o.filter((id) => id !== sheetId));
    setActiveId((a) => (a === sheetId ? null : a));
    setSideId((a) => (a === sheetId ? null : a));
  }, []);

  const open = useCallback((sheetId: string) => {
    setOpenIds((o) => (o.includes(sheetId) ? o : [...o, sheetId]));
    setActiveId(sheetId);
    setSideId((s) => (s === sheetId ? null : s));
    setWorkspaceOpen(true);
  }, []);

  const close = useCallback((sheetId: string) => {
    setOpenIds((o) => {
      const rest = o.filter((id) => id !== sheetId);
      setActiveId((a) => (a === sheetId ? (rest[rest.length - 1] ?? null) : a));
      return rest;
    });
    setSideId((s) => (s === sheetId ? null : s));
  }, []);

  const activate = useCallback((sheetId: string) => {
    setActiveId(sheetId);
    setSideId((s) => (s === sheetId ? null : s));
  }, []);

  const setSide = useCallback((sheetId: string | null) => setSideId(sheetId), []);

  // Il workspace si chiude da solo quando non resta nulla da mostrare.
  useEffect(() => {
    if (workspaceOpen && openIds.length === 0) setWorkspaceOpen(false);
  }, [workspaceOpen, openIds.length]);

  // ---- Scheda -> token (solo GM) ----
  const { view } = useRealtimeState();
  const { run } = useCommands();
  useEffect(() => {
    if (!isGm || !view || !syncTokens) return;
    for (const u of planTokenSync(sheets, view.tokens)) void run({ type: "token.update", tokenId: u.tokenId, patch: u.patch });
  }, [isGm, view, sheets, run, syncTokens]);

  const value = useMemo<SheetsContextValue>(
    () => ({
      campaignId,
      user,
      isGm,
      sheets,
      loading,
      error,
      refresh,
      upsert,
      remove,
      openIds,
      activeId,
      sideId,
      workspaceOpen,
      open,
      close,
      activate,
      setSide,
      setWorkspaceOpen
    }),
    [campaignId, user, isGm, sheets, loading, error, refresh, upsert, remove, openIds, activeId, sideId, workspaceOpen, open, close, activate, setSide]
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}
