import { useEffect, useState, type ReactNode } from "react";
import { Dices, KeyRound, LogOut, Map as MapIcon, MessageSquare, PanelRight, Settings, ShieldCheck, Users } from "lucide-react";
import { Avatar, IconButton, Menu, Sheet, Tabs, type MenuItemSpec } from "../ui";
import { useSession } from "../session/SessionProvider";
import { navigate } from "../router/hashRouter";
import { ChangePasswordSheet } from "./ChangePasswordSheet";
import { EmptyState } from "./EmptyState";
import "./app.css";

/** Nome mostrato nella barra finche' non esistono le campagne. */
const CAMPAIGN_NAME = "Campagna senza titolo";

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

function SidePanel(): ReactNode {
  return (
    <Tabs
      aria-label="Pannello del tavolo"
      className="a-side__tabs"
      tabs={[
        {
          id: "chat",
          label: "Chat",
          icon: <MessageSquare size={16} />,
          content: <EmptyState icon={<MessageSquare size={28} />} title="Nessun messaggio" description="Qui compariranno i messaggi e i tiri di dado della partita." />
        },
        {
          id: "token",
          label: "Token",
          icon: <Dices size={16} />,
          content: <EmptyState icon={<Dices size={28} />} title="Nessun token" description="I personaggi e i mostri in scena saranno elencati qui." />
        },
        {
          id: "settings",
          label: "Impostazioni",
          icon: <Settings size={16} />,
          content: <EmptyState icon={<Settings size={28} />} title="Nessuna impostazione" description="Griglia, scala e preferenze del tavolo arriveranno con la mappa." />
        }
      ]}
    />
  );
}

/** Tavolo: barra superiore, area per la mappa e pannello laterale (sidebar su schermi larghi, sheet su telefono). */
export function TableScreen() {
  const { user, logout } = useSession();
  const wide = useWide();
  const [panelOpen, setPanelOpen] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  if (!user) return null;

  const items: MenuItemSpec[] = [
    { id: "password", label: "Cambia password", icon: <KeyRound size={18} />, onSelect: () => setPasswordOpen(true) },
    ...(user.role === "admin"
      ? [{ id: "users", label: "Gestione utenti", icon: <Users size={18} />, onSelect: () => navigate("/admin/users") } satisfies MenuItemSpec]
      : []),
    { id: "logout", label: "Esci", icon: <LogOut size={18} />, destructive: true, onSelect: () => void doLogout() }
  ];

  async function doLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    await logout().catch(() => undefined);
  }

  return (
    <div className="a-table">
      <a className="a-skip" href="#/" onClick={(e) => { e.preventDefault(); document.getElementById("mappa")?.focus(); }}>
        Vai alla mappa
      </a>
      <header className="a-topbar l-material l-material--regular">
        <div className="a-topbar__title">
          <span className="a-topbar__app t-caption1 a-muted">Lanterna</span>
          <h1 className="t-headline a-topbar__campaign">{CAMPAIGN_NAME}</h1>
        </div>
        <div className="a-topbar__actions">
          <IconButton
            label={wide && panelOpen ? "Nascondi pannello" : "Mostra pannello"}
            icon={<PanelRight size={20} />}
            aria-pressed={wide ? panelOpen : undefined}
            onClick={() => (wide ? setPanelOpen((v) => !v) : setSheetOpen(true))}
          />
          <Menu
            label={`Menu di ${user.name}`}
            placement="bottom-end"
            items={items}
            trigger={<IconButton label={`Menu utente, ${user.name}`} icon={<Avatar name={user.name} size="sm" />} />}
          />
        </div>
      </header>

      <div className="a-table__body">
        <main id="mappa" tabIndex={-1} className="a-map" aria-label="Mappa">
          <EmptyState
            icon={<MapIcon size={36} />}
            title="In attesa della mappa"
            description={
              user.role === "admin"
                ? "Quando carichi una mappa comparira' qui, con la griglia e i token."
                : "Il GM non ha ancora caricato una mappa. Comparira' qui appena sara' pronta."
            }
          />
          {user.role === "admin" ? (
            <p className="a-map__badge t-caption1 a-muted">
              <ShieldCheck size={14} aria-hidden="true" /> Sei il GM di questo tavolo
            </p>
          ) : null}
        </main>

        {wide && panelOpen ? (
          <aside className="a-side l-material l-material--thick a-enter-side" aria-label="Pannello laterale">
            <SidePanel />
          </aside>
        ) : null}
      </div>

      {!wide ? (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen} title="Pannello del tavolo">
          <SidePanel />
        </Sheet>
      ) : null}
      <ChangePasswordSheet open={passwordOpen} onOpenChange={setPasswordOpen} />
    </div>
  );
}
