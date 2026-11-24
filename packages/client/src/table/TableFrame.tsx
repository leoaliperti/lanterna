import { useEffect, useState, type ReactNode } from "react";
import { KeyRound, LogOut, Maximize, Minimize, PanelRight, Settings, Users } from "lucide-react";
import { Avatar, IconButton, Menu, Sheet, Tabs, type MenuItemSpec, type TabItem } from "../ui";
import type { SessionUser } from "../api/client";
import { useSession } from "../session/SessionProvider";
import { navigate } from "../router/hashRouter";
import { ChangePasswordSheet } from "../screens/ChangePasswordSheet";
import { SettingsSheet } from "../settings/SettingsSheet";

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
  /** Etichetta di ruolo accanto al titolo (es. "GM"): in barra, mai sopra la mappa. */
  badge?: ReactNode;
  /** Sotto la barra (avvisi di connessione). */
  banner?: ReactNode;
  /** Schede del pannello laterale; senza, il pannello non c'e'. `closeSheet` chiude lo sheet su telefono. */
  tabs?: (ctx: { closeSheet: () => void }) => TabItem[];
  /** Scheda aperta all'inizio (default: la prima). */
  defaultTab?: string;
  /** Apre il pannello (o lo sheet) sulla scheda indicata a ogni cambio di `nonce` (scorciatoie da tastiera). */
  focusRequest?: { tab: string; nonce: number };
  /** Scheda attualmente visibile all'utente, o `null` se il pannello e' chiuso. */
  onVisibleTabChange?: (tab: string | null) => void;
  /** Nuovi elementi da segnalare sul pulsante del pannello quando e' chiuso. */
  panelBadge?: number;
  children: ReactNode;
}

/**
 * Cornice del tavolo: barra superiore con menu utente, area centrale e pannello laterale
 * (sidebar su schermi larghi, sheet su telefono e tablet stretto).
 */
export function TableFrame({
  user,
  title,
  actions,
  badge,
  banner,
  tabs,
  defaultTab,
  focusRequest,
  onVisibleTabChange,
  panelBadge = 0,
  children
}: TableFrameProps) {
  const { logout } = useSession();
  const wide = useWide();
  const [panelOpen, setPanelOpen] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const tabItems = tabs?.({ closeSheet: () => setSheetOpen(false) });
  const [tab, setTab] = useState<string | undefined>(defaultTab);
  const currentTab = tabItems?.some((t) => t.id === tab) ? tab : tabItems?.[0]?.id;
  const panelShown = tabs ? (wide ? panelOpen : sheetOpen) : false;

  useEffect(() => {
    onVisibleTabChange?.(panelShown && currentTab ? currentTab : null);
  }, [panelShown, currentTab, onVisibleTabChange]);

  // Una nuova richiesta di focus apre il pannello sulla scheda richiesta (solo a ogni nonce).
  const nonce = focusRequest?.nonce ?? 0;
  const wantedTab = focusRequest?.tab;
  useEffect(() => {
    if (!nonce || !wantedTab) return;
    setTab(wantedTab);
    if (wide) setPanelOpen(true);
    else setSheetOpen(true);
  }, [nonce]);
  const [loggingOut, setLoggingOut] = useState(false);

  async function doLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    await logout().catch(() => undefined);
  }

  const items: MenuItemSpec[] = [
    { id: "settings", label: "Impostazioni", icon: <Settings size={18} />, onSelect: () => setSettingsOpen(true) },
    { id: "password", label: "Cambia password", icon: <KeyRound size={18} />, onSelect: () => setPasswordOpen(true) },
    ...(user.role === "admin"
      ? [{ id: "users", label: "Gestione utenti", icon: <Users size={18} />, onSelect: () => navigate("/admin/users") } satisfies MenuItemSpec]
      : []),
    { id: "logout", label: "Esci", icon: <LogOut size={18} />, destructive: true, onSelect: () => void doLogout() }
  ];

  const sidePanel = tabs ? (
    <Tabs aria-label="Pannello del tavolo" className="a-side__tabs" value={currentTab} onValueChange={setTab} tabs={tabItems ?? []} />
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
          {badge}
        </div>
        <div className="a-topbar__actions">
          {actions}
          <FullscreenButton />
          {tabs ? (
            <IconButton
              label={wide && panelOpen ? "Nascondi pannello" : panelBadge > 0 ? `Mostra pannello (${panelBadge} nuovi)` : "Mostra pannello"}
              icon={
                <span className="a-dotwrap">
                  <PanelRight size={20} />
                  {panelBadge > 0 && !panelShown ? <span className="a-dot" /> : null}
                </span>
              }
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
      <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}

/**
 * Schermo intero del tavolo (API Fullscreen del browser). Se il browser non lo supporta (es. iPhone
 * in Safari, che lo permette solo per i video) il pulsante non compare.
 */
function FullscreenButton() {
  const supported = typeof document !== "undefined" && typeof document.documentElement.requestFullscreen === "function";
  const [active, setActive] = useState(() => typeof document !== "undefined" && !!document.fullscreenElement);
  useEffect(() => {
    const onChange = () => setActive(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  if (!supported) return null;
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  };
  return (
    <IconButton
      label={active ? "Esci dallo schermo intero" : "Schermo intero"}
      icon={active ? <Minimize size={18} /> : <Maximize size={18} />}
      variant={active ? "tinted" : "plain"}
      aria-pressed={active}
      onClick={toggle}
    />
  );
}
