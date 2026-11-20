import { useEffect, useState, type ReactNode } from "react";
import { KeyRound, LogOut, PanelRight, Users } from "lucide-react";
import { Avatar, IconButton, Menu, Sheet, Tabs, type MenuItemSpec, type TabItem } from "../ui";
import type { SessionUser } from "../api/client";
import { useSession } from "../session/SessionProvider";
import { navigate } from "../router/hashRouter";
import { ChangePasswordSheet } from "../screens/ChangePasswordSheet";

const WIDE = "(min-width: 56rem)";

function useWide(): boolean {
  const query = () => (typeof window.matchMedia === "function" ? window.matchMedia(WIDE).matches : false);
  const [wide, setWide] = useState(query);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return wide;
}

export interface TableFrameProps {
  user: SessionUser;
  title: string;
  /** Pulsanti accanto al menu utente (annulla, ripeti, stato della connessione). */
  actions?: ReactNode;
  /** Sotto la barra (avvisi di connessione). */
  banner?: ReactNode;
  /** Schede del pannello laterale; senza, il pannello non c'e'. `closeSheet` chiude lo sheet su telefono. */
  tabs?: (ctx: { closeSheet: () => void }) => TabItem[];
  /** Scheda aperta all'inizio (default: la prima). */
  defaultTab?: string;
  children: ReactNode;
}

/**
 * Cornice del tavolo: barra superiore con menu utente, area centrale e pannello laterale
 * (sidebar su schermi larghi, sheet su telefono e tablet stretto).
 */
export function TableFrame({ user, title, actions, banner, tabs, defaultTab, children }: TableFrameProps) {
  const { logout } = useSession();
  const wide = useWide();
  const [panelOpen, setPanelOpen] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  async function doLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    await logout().catch(() => undefined);
  }

  const items: MenuItemSpec[] = [
    { id: "password", label: "Cambia password", icon: <KeyRound size={18} />, onSelect: () => setPasswordOpen(true) },
    ...(user.role === "admin"
      ? [{ id: "users", label: "Gestione utenti", icon: <Users size={18} />, onSelect: () => navigate("/admin/users") } satisfies MenuItemSpec]
      : []),
    { id: "logout", label: "Esci", icon: <LogOut size={18} />, destructive: true, onSelect: () => void doLogout() }
  ];

  const sidePanel = tabs ? (
    <Tabs aria-label="Pannello del tavolo" className="a-side__tabs" defaultValue={defaultTab} tabs={tabs({ closeSheet: () => setSheetOpen(false) })} />
  ) : null;

  return (
    <div className="a-table">
      <a
        className="a-skip"
        href="#/"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("mappa")?.focus();
        }}
      >
        Vai alla mappa
      </a>
      <header className="a-topbar l-material l-material--regular">
        <div className="a-topbar__title">
          <span className="a-topbar__app t-caption1 a-muted">Lanterna</span>
          <h1 className="t-headline a-topbar__campaign">{title}</h1>
        </div>
        <div className="a-topbar__actions">
          {actions}
          {tabs ? (
            <IconButton
              label={wide && panelOpen ? "Nascondi pannello" : "Mostra pannello"}
              icon={<PanelRight size={20} />}
              aria-pressed={wide ? panelOpen : undefined}
              onClick={() => (wide ? setPanelOpen((v) => !v) : setSheetOpen(true))}
            />
          ) : null}
          <Menu
            label={`Menu di ${user.name}`}
            placement="bottom-end"
            items={items}
            trigger={<IconButton label={`Menu utente, ${user.name}`} icon={<Avatar name={user.name} size="sm" />} />}
          />
        </div>
      </header>
      {banner}

      <div className="a-table__body">
        <main id="mappa" tabIndex={-1} className="a-map" aria-label="Mappa">
          {children}
        </main>
        {sidePanel && wide && panelOpen ? (
          <aside className="a-side l-material l-material--thick a-enter-side" aria-label="Pannello laterale">
            {sidePanel}
          </aside>
        ) : null}
      </div>

      {sidePanel && !wide ? (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen} title="Pannello del tavolo">
          {sidePanel}
        </Sheet>
      ) : null}
      <ChangePasswordSheet open={passwordOpen} onOpenChange={setPasswordOpen} />
    </div>
  );
}
