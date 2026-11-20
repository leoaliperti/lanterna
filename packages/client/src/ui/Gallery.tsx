import { useEffect, useState, type ReactNode } from "react";
import { Bell, Copy, Dices, Map as MapIcon, MessageSquare, Pencil, Settings, Share, Trash2, Users } from "lucide-react";
import {
  Alert,
  Avatar,
  Badge,
  Banner,
  Button,
  Card,
  ContextMenu,
  IconButton,
  List,
  ListRow,
  Material,
  Menu,
  NavigationBar,
  Picker,
  Popover,
  ProgressView,
  SearchField,
  SecureField,
  SegmentedControl,
  Sheet,
  Sidebar,
  Slider,
  Spinner,
  Stepper,
  Tabs,
  TextField,
  Toggle,
  ToastProvider,
  Toolbar,
  Tooltip,
  useToast
} from "./index";
import "./gallery.css";

type ThemeMode = "auto" | "light" | "dark" | "split";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="g-section">
      <h2 className="t-title3 g-section__title">{title}</h2>
      <div className="g-section__body">{children}</div>
    </section>
  );
}

function ToastDemo() {
  const toast = useToast();
  return (
    <div className="g-row">
      <Button variant="tinted" onClick={() => toast.show({ title: "Mappa salvata", message: "Salvataggio automatico completato.", tone: "success" })}>
        Toast
      </Button>
      <Button variant="gray" onClick={() => toast.show({ title: "Connessione persa", message: "Riprovo tra poco.", tone: "danger", duration: 6000 })}>
        Toast errore
      </Button>
    </div>
  );
}

function Showcase() {
  const [sheet, setSheet] = useState(false);
  const [alert, setAlert] = useState(false);
  const [seg, setSeg] = useState<"mappa" | "token" | "chat">("mappa");
  const [vol, setVol] = useState(40);
  const [n, setN] = useState(3);
  const [tab, setTab] = useState("a");
  const [side, setSide] = useState("mappe");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className="g-page">
      <NavigationBar
        title="Componenti"
        leading={<IconButton label="Impostazioni" icon={<Settings size={20} />} />}
        trailing={<IconButton label="Notifiche" icon={<Bell size={20} />} />}
      />

      <div className="g-body">
        <Section title="Tipografia">
          <div className="g-type">
            <p className="t-large-title">Large Title 34</p>
            <p className="t-title1">Title 1 28</p>
            <p className="t-title2">Title 2 22</p>
            <p className="t-title3">Title 3 20</p>
            <p className="t-headline">Headline 17 semibold</p>
            <p className="t-body">Body 17</p>
            <p className="t-callout">Callout 16</p>
            <p className="t-subhead">Subhead 15</p>
            <p className="t-footnote">Footnote 13</p>
            <p className="t-caption1">Caption 12</p>
            <p className="t-caption2">Caption 11</p>
          </div>
        </Section>

        <Section title="Pulsanti">
          <div className="g-row">
            <Button>Filled</Button>
            <Button variant="tinted">Tinted</Button>
            <Button variant="gray">Gray</Button>
            <Button variant="plain">Plain</Button>
            <Button variant="destructive">Destructive</Button>
            <Button disabled>Disabilitato</Button>
          </div>
          <div className="g-row">
            <Button size="sm">Piccolo</Button>
            <Button size="lg" icon={<Dices size={20} />}>Grande</Button>
            <Button
              variant="tinted"
              loading={busy}
              onClick={() => {
                setBusy(true);
                setTimeout(() => setBusy(false), 1500);
              }}
            >
              Carica
            </Button>
          </div>
          <div className="g-row">
            <IconButton label="Condividi" icon={<Share size={20} />} />
            <IconButton label="Modifica" variant="tinted" icon={<Pencil size={20} />} />
            <IconButton label="Copia" variant="gray" icon={<Copy size={20} />} />
            <IconButton label="Elimina" variant="filled" icon={<Trash2 size={20} />} />
          </div>
        </Section>

        <Section title="Campi">
          <div className="g-stack">
            <TextField label="Nome personaggio" placeholder="Es. Aldric" value={name} onChange={(e) => setName(e.target.value)} helper="Visibile a tutti i giocatori." />
            <TextField label="Email" type="email" defaultValue="non-valida" error="Inserisci un indirizzo valido." />
            <SecureField label="Password" />
            <SearchField placeholder="Cerca mappe" />
          </div>
        </Section>

        <Section title="Controlli">
          <div className="g-stack">
            <SegmentedControl aria-label="Vista" value={seg} onValueChange={setSeg} options={[{ value: "mappa", label: "Mappa" }, { value: "token", label: "Token" }, { value: "chat", label: "Chat" }]} />
            <Toggle label="Mostra griglia" defaultChecked />
            <Toggle label="Snap alla griglia" />
            <div>
              <p className="t-footnote g-muted">Volume: {vol}</p>
              <Slider aria-label="Volume" value={vol} onValueChange={setVol} />
            </div>
            <div className="g-row g-between">
              <span>Giocatori: {n}</span>
              <Stepper label="giocatori" value={n} onValueChange={setN} min={1} max={8} />
            </div>
            <div className="g-row g-between">
              <span>Unità di misura</span>
              <Picker label="Unità" defaultValue="ft" options={[{ value: "ft", label: "Piedi" }, { value: "m", label: "Metri" }, { value: "sq", label: "Caselle" }]} />
            </div>
          </div>
        </Section>

        <Section title="Liste (inset grouped)">
          <List header="Sessione" footer="Solo il GM può modificare questi valori.">
            <ListRow leading={<MapIcon size={20} />} title="Mappa" subtitle="La Cripta Dimenticata" chevron onPress={() => undefined} />
            <ListRow leading={<Users size={20} />} title="Giocatori" trailing={<Badge>4</Badge>} chevron onPress={() => undefined} />
            <ListRow leading={<MessageSquare size={20} />} title="Chat" trailing="Attiva" />
            <ListRow title="Chiudi sessione" destructive onPress={() => setAlert(true)} />
          </List>
        </Section>

        <Section title="Navigazione">
          <Tabs
            aria-label="Sezioni"
            value={tab}
            onValueChange={setTab}
            tabs={[
              { id: "a", label: "Scheda", content: <p>Contenuto della scheda.</p> },
              { id: "b", label: "Inventario", content: <p>Oggetti trasportati.</p> },
              { id: "c", label: "Note", content: <p>Appunti privati.</p> }
            ]}
          />
          <div className="g-split">
            <Sidebar
              aria-label="Libreria"
              selected={side}
              onSelect={setSide}
              sections={[
                { title: "Libreria", items: [{ id: "mappe", label: "Mappe", icon: <MapIcon size={18} /> }, { id: "token", label: "Token", icon: <Users size={18} />, badge: <Badge tone="gray">12</Badge> }] },
                { items: [{ id: "imp", label: "Impostazioni", icon: <Settings size={18} /> }] }
              ]}
            />
            <Toolbar aria-label="Strumenti" position="top">
              <IconButton label="Modifica" icon={<Pencil size={20} />} />
              <IconButton label="Copia" icon={<Copy size={20} />} />
              <IconButton label="Elimina" icon={<Trash2 size={20} />} />
            </Toolbar>
          </div>
        </Section>

        <Section title="Sovrapposizioni">
          <div className="g-row">
            <Button onClick={() => setSheet(true)}>Apri sheet</Button>
            <Button variant="destructive" onClick={() => setAlert(true)}>Mostra alert</Button>
            <Popover label="Dettagli" trigger={<Button variant="gray">Popover</Button>}>
              <p className="t-headline">Torcia</p>
              <p className="t-footnote g-muted">Illumina 6 caselle per 1 ora.</p>
            </Popover>
            <Menu
              label="Azioni"
              trigger={<Button variant="gray">Menu</Button>}
              items={[
                { id: "m", label: "Modifica", icon: <Pencil size={16} /> },
                { id: "c", label: "Duplica", icon: <Copy size={16} /> },
                { id: "d", label: "Elimina", icon: <Trash2 size={16} />, destructive: true }
              ]}
            />
            <Tooltip content="Lancia un d20">
              <IconButton label="Lancia dado" variant="tinted" icon={<Dices size={20} />} />
            </Tooltip>
          </div>
          <ContextMenu label="Azioni sul token" items={[{ id: "a", label: "Seleziona" }, { id: "b", label: "Nascondi" }, { id: "c", label: "Elimina", destructive: true }]}>
            <Card className="g-context">Tasto destro (o pressione prolungata) qui</Card>
          </ContextMenu>
          <ToastDemo />
          <Banner tone="info" title="Suggerimento">Trascina la maniglia dello sheet per chiuderlo.</Banner>
          <Banner tone="warning" title="Connessione instabile">Alcune modifiche potrebbero arrivare in ritardo.</Banner>
          <Banner tone="danger" title="Errore">Impossibile salvare la mappa.</Banner>
        </Section>

        <Section title="Visualizzazione">
          <div className="g-row">
            <Avatar name="Aldric Vento" size="lg" />
            <Avatar name="Brenna" />
            <Avatar name="Cael Ombra" size="sm" />
            <Badge>3</Badge>
            <Badge tone="red">Nuovo</Badge>
            <Badge tone="green">Online</Badge>
            <Badge tone="orange">Lento</Badge>
            <Badge tone="gray">Gray</Badge>
            <Spinner />
          </div>
          <div className="g-stack">
            <ProgressView label="Caricamento mappa" value={0.6} />
            <ProgressView label="Attesa" />
          </div>
          <div className="g-stack">
            <Card>
              <p className="t-headline">Card</p>
              <p className="t-subhead g-muted">Superficie raggruppata con ombra morbida.</p>
            </Card>
            <Material thickness="regular">
              <p className="t-headline">Material regular</p>
              <p className="t-subhead g-muted">Traslucido con fallback opaco.</p>
            </Material>
          </div>
        </Section>
      </div>

      <Toolbar aria-label="Barra inferiore">
        <Button variant="plain" size="sm">Annulla</Button>
        <Button variant="plain" size="sm">Ripeti</Button>
        <Button variant="plain" size="sm">Griglia</Button>
      </Toolbar>

      <Sheet open={sheet} onOpenChange={setSheet} title="Nuovo token">
        <div className="g-stack">
          <TextField label="Nome" placeholder="Goblin" />
          <Toggle label="Nascosto ai giocatori" />
          <Button fullWidth onClick={() => setSheet(false)}>Aggiungi</Button>
        </div>
      </Sheet>
      <Alert
        open={alert}
        onOpenChange={setAlert}
        title="Chiudere la sessione?"
        message="I giocatori verranno disconnessi."
        actions={[{ label: "Annulla", role: "cancel" }, { label: "Chiudi", role: "destructive" }]}
      />
    </div>
  );
}

export function Gallery() {
  const [mode, setMode] = useState<ThemeMode>("auto");

  useEffect(() => {
    const root = document.documentElement;
    if (mode === "light" || mode === "dark") root.dataset.theme = mode;
    else delete root.dataset.theme;
    return () => {
      delete root.dataset.theme;
    };
  }, [mode]);

  return (
    <ToastProvider>
      <div className="g-shell">
        <div className="g-themebar">
          <SegmentedControl
            aria-label="Tema"
            value={mode}
            onValueChange={setMode}
            options={[{ value: "auto", label: "Auto" }, { value: "light", label: "Chiaro" }, { value: "dark", label: "Scuro" }, { value: "split", label: "Affianca" }]}
          />
        </div>
        {mode === "split" ? (
          <div className="g-columns">
            <div data-theme="light" className="g-col"><Showcase /></div>
            <div data-theme="dark" className="g-col"><Showcase /></div>
          </div>
        ) : (
          <Showcase />
        )}
      </div>
    </ToastProvider>
  );
}
