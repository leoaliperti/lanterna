import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getSession, setUnauthorizedHandler, signIn, signOut, type SessionUser } from "../api/client";

export type SessionStatus = "loading" | "anonymous" | "authenticated";

interface SessionValue {
  status: SessionStatus;
  user: SessionUser | null;
  /** Lancia ApiRequestError se le credenziali non sono valide. */
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession va usato dentro SessionProvider");
  return ctx;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ status: SessionStatus; user: SessionUser | null }>({ status: "loading", user: null });

  useEffect(() => {
    let alive = true;
    getSession()
      .then((user) => alive && setState(user ? { status: "authenticated", user } : { status: "anonymous", user: null }))
      .catch(() => alive && setState({ status: "anonymous", user: null }));
    setUnauthorizedHandler(() => setState({ status: "anonymous", user: null }));
    return () => {
      alive = false;
      setUnauthorizedHandler(null);
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    await signIn(email, password);
    const user = await getSession();
    if (!user) throw new Error("Sessione non creata");
    setState({ status: "authenticated", user });
  }, []);

  const logout = useCallback(async () => {
    try {
      await signOut();
    } finally {
      // Anche se il server non risponde, il client non mostra piu' nulla dell'utente.
      setState({ status: "anonymous", user: null });
    }
  }, []);

  const value = useMemo<SessionValue>(() => ({ ...state, login, logout }), [state, login, logout]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
