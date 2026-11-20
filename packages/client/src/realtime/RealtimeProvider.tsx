import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Command } from "@lanterna/shared";
import { getSession } from "../api/client";
import { useToast } from "../ui";
import { commandErrorToast } from "./errors";
import { RealtimeClient, type RealtimeState } from "./RealtimeClient";
import { wsUrl } from "./urls";

const ClientContext = createContext<RealtimeClient | null>(null);

export interface RealtimeProviderProps {
  campaignId: string;
  children: ReactNode;
  /** Chiamato quando il server dichiara scaduta la sessione (tornare al login). */
  onSessionEnded?: () => void;
  /** Per i test: un client gia' pronto al posto di quello reale. */
  client?: RealtimeClient;
}

/** Crea il client WebSocket della campagna, lo avvia e lo ferma allo smontaggio. */
export function RealtimeProvider({ campaignId, children, onSessionEnded, client: injected }: RealtimeProviderProps) {
  const toast = useToast();
  const [client] = useState(
    () =>
      injected ??
      new RealtimeClient({
        campaignId,
        url: wsUrl(),
        verifySession: async () => (await getSession().catch(() => ({ id: "?" }))) !== null
      })
  );

  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);

  useEffect(
    () =>
      client.onEvent((e) => {
        if (e.type === "error") toast.show(commandErrorToast({ code: e.code, message: e.message }));
        else if (e.type === "session-ended") onSessionEnded?.();
      }),
    [client, toast, onSessionEnded]
  );

  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

export function useRealtimeClient(): RealtimeClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("useRealtimeClient va usato dentro <RealtimeProvider>");
  return client;
}

/** Stato corrente (vista, connessione). Si aggiorna a ogni snapshot/delta. */
export function useRealtimeState(): RealtimeState {
  const client = useRealtimeClient();
  return useSyncExternalStore(client.subscribe, client.getState, client.getState);
}

export interface Commands {
  /** Invia un comando e mostra un toast se il server lo rifiuta. Restituisce true se e' stato accettato. */
  run: (command: Command) => Promise<boolean>;
  undo: () => Promise<boolean>;
  redo: () => Promise<boolean>;
}

export function useCommands(): Commands {
  const client = useRealtimeClient();
  const toast = useToast();
  const report = useCallback(
    async (p: ReturnType<RealtimeClient["undo"]>) => {
      const r = await p;
      if (!r.ok) toast.show(commandErrorToast(r));
      return r.ok;
    },
    [toast]
  );
  return useMemo(
    () => ({
      run: (c) => report(client.sendCommand(c)),
      undo: () => report(client.undo()),
      redo: () => report(client.redo())
    }),
    [client, report]
  );
}
