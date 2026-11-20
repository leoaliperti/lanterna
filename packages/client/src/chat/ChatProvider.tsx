import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Member } from "@lanterna/shared";
import { useRealtimeClient, useRealtimeState } from "../realtime/RealtimeProvider";
import { ChatStore, type ChatState } from "./ChatStore";

const StoreContext = createContext<ChatStore | null>(null);

export interface ChatProviderProps {
  selfId: string;
  children: ReactNode;
}

const NO_MEMBERS: readonly Member[] = [];

/** Tiene la cronologia della chat anche con il pannello chiuso (serve a badge e animazione dei dadi). */
export function ChatProvider({ selfId, children }: ChatProviderProps) {
  const client = useRealtimeClient();
  const { view } = useRealtimeState();
  const members = useRef<readonly Member[]>(NO_MEMBERS);
  members.current = view?.members ?? NO_MEMBERS;
  const [store] = useState(() => new ChatStore({ client, selfId, getMembers: () => members.current }));

  // Gli effetti dei figli girano prima di `client.start()` del provider padre: nessun messaggio si perde.
  useEffect(() => store.attach(), [store]);

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useChatStore(): ChatStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useChatStore va usato dentro <ChatProvider>");
  return store;
}

export function useChat(): ChatState {
  const store = useChatStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
