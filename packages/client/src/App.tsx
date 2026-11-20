import { useEffect } from "react";
import { Spinner } from "./ui";
import { useSession } from "./session/SessionProvider";
import { navigate, usePath } from "./router/hashRouter";
import { LoginScreen } from "./screens/LoginScreen";
import { TableScreen } from "./screens/TableScreen";
import { AdminUsersScreen } from "./screens/AdminUsersScreen";
import { BackupScreen } from "./screens/BackupScreen";
import "./screens/app.css";

type Screen = "loading" | "login" | "table" | "admin-users" | "admin-backup" | "redirect-home";

const TITLES: Record<Screen, string> = {
  loading: "Lanterna",
  login: "Accedi - Lanterna",
  table: "Tavolo - Lanterna",
  "admin-users": "Gestione utenti - Lanterna",
  "admin-backup": "Backup e importazione - Lanterna",
  "redirect-home": "Lanterna"
};

/**
 * Route protette. Chi non ha una sessione vede solo il login; la route admin e' raggiungibile solo
 * dall'admin (UX: la verifica vera e' sul server, che risponde 403 ai non admin).
 */
export function resolveScreen(path: string, status: "loading" | "anonymous" | "authenticated", role: string | undefined): Screen {
  if (status === "loading") return "loading";
  if (status === "anonymous") return "login";
  if (path === "/") return "table";
  if (path === "/admin/users" && role === "admin") return "admin-users";
  if (path === "/admin/backup" && role === "admin") return "admin-backup";
  return "redirect-home";
}

export function App() {
  const { status, user } = useSession();
  const path = usePath();
  const screen = resolveScreen(path, status, user?.role);

  useEffect(() => {
    if (screen === "redirect-home") navigate("/", { replace: true });
  }, [screen]);

  useEffect(() => {
    document.title = TITLES[screen];
  }, [screen]);

  return (
    <>
      {screen === "loading" ? (
        <div className="a-splash">
          <Spinner label="Caricamento di Lanterna" size="lg" />
        </div>
      ) : screen === "login" ? (
        <LoginScreen />
      ) : screen === "table" ? (
        <TableScreen />
      ) : screen === "admin-users" ? (
        <AdminUsersScreen />
      ) : screen === "admin-backup" ? (
        <BackupScreen />
      ) : null}
      <p className="l-sr-only" role="status" aria-live="polite">
        {screen === "table"
          ? "Tavolo"
          : screen === "admin-users"
            ? "Gestione utenti"
            : screen === "admin-backup"
              ? "Backup e importazione"
              : screen === "login"
                ? "Accesso"
                : ""}
      </p>
    </>
  );
}
