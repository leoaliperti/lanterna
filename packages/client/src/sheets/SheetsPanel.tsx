import { useMemo, useState } from "react";
import { FileText, Plus, ScrollText, Skull, UserRound } from "lucide-react";
import { blankDoc, monsterDocFromContent, type SheetSummary } from "@lanterna/shared";
import { Badge, Banner, Button, List, ListRow, Picker, SearchField, SegmentedControl, Sheet, Spinner, TextField, useToast } from "../ui";
import { EmptyState } from "../screens/EmptyState";
import { useRealtimeState } from "../realtime/RealtimeProvider";
import { LibraryPicker } from "./LibraryPicker";
import { matchesQuery } from "./sheetLogic";
import { createSheet, sheetErrorMessage } from "./sheetsApi";
import { useSheets } from "./SheetsProvider";
import { FormManager } from "../forms/FormManager";

type Filter = "all" | "pc" | "monster";

export interface SheetsPanelProps {
  /** Chiamato dopo l'apertura di una scheda (su telefono chiude il pannello laterale). */
  onOpened?: () => void;
}

function describe(s: SheetSummary): string {
  const base = `${s.kind === "monster" ? "Statblock" : "Personaggio"} · liv. ${s.level} · PF ${s.hp.current}/${s.hp.max}`;
  return base;
}

/** Elenco delle schede nel pannello laterale, con ricerca. Il giocatore vede solo le proprie (lo decide il server). */
export function SheetsPanel({ onOpened }: SheetsPanelProps) {
  const { sheets, loading, error, refresh, isGm, open, campaignId, upsert } = useSheets();
  const { view } = useRealtimeState();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [creating, setCreating] = useState<"pc" | "monster-library" | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("none");
  const [busy, setBusy] = useState(false);

  const members = view?.members ?? [];
  const ownerName = (id: string | null) => members.find((m) => m.userId === id)?.displayName;
  const tokenName = (id: string | null | undefined) => (id ? view?.tokens.find((t) => t.id === id)?.name : undefined);

  const shown = useMemo(
    () =>
      sheets.filter(
        (s) => (filter === "all" || s.kind === filter) && matchesQuery(query, s.name, view?.members.find((m) => m.userId === s.ownerUserId)?.displayName)
      ),
    [sheets, filter, query, view]
  );

  const opened = (id: string) => {
    open(id);
    onOpened?.();
  };

  const run = async (make: () => Promise<{ id: string } & SheetSummary>) => {
    setBusy(true);
    try {
      const rec = await make();
      upsert(rec);
      setCreating(null);
      setName("");
      opened(rec.id);
    } catch (err) {
      toast.show({ title: "Creazione non riuscita", message: sheetErrorMessage(err), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="a-panel">
      <div className="a-panel__bar">
        <Button size="sm" icon={<Plus size={16} />} onClick={() => setCreating("pc")}>
          Nuovo personaggio
        </Button>
        {isGm ? (
          <Button size="sm" variant="gray" icon={<Skull size={16} />} onClick={() => setCreating("monster-library")}>
            Mostro
          </Button>
        ) : null}
        {isGm ? (
          <Button size="sm" variant="gray" icon={<FileText size={16} />} onClick={() => setFormOpen(true)}>
            Modulo PDF
          </Button>
        ) : null}
      </div>
      {isGm ? <FormManager open={formOpen} onOpenChange={setFormOpen} campaignId={campaignId} /> : null}
      <SearchField placeholder="Cerca una scheda" label="Cerca una scheda" value={query} onValueChange={setQuery} />
      {isGm ? (
        <SegmentedControl
          aria-label="Tipo di scheda"
          value={filter}
          onValueChange={setFilter}
          options={[
            { value: "all", label: "Tutte" },
            { value: "pc", label: "Personaggi" },
            { value: "monster", label: "Mostri" }
          ]}
        />
      ) : null}
      {error ? (
        <Banner tone="danger" title="Schede non caricate">
          <p>{error}</p>
          <Button size="sm" variant="gray" onClick={() => void refresh()}>
            Riprova
          </Button>
        </Banner>
      ) : null}
      {loading ? (
        <Spinner label="Caricamento delle schede" />
      ) : sheets.length === 0 ? (
        <EmptyState
          icon={<ScrollText size={28} />}
          title="Nessuna scheda"
          description={isGm ? "Crea un personaggio o richiama un mostro dalla libreria importata." : "Crea la scheda del tuo personaggio."}
        />
      ) : shown.length === 0 ? (
        <EmptyState icon={<ScrollText size={28} />} title="Nessun risultato" description="Nessuna scheda corrisponde alla ricerca." />
      ) : (
        <List aria-label="Schede">
          {shown.map((s) => {
            const who = s.kind === "pc" ? ownerName(s.ownerUserId) : undefined;
            const token = isGm ? tokenName(s.tokenId) : undefined;
            return (
              <ListRow
                key={s.id}
                title={s.name || "Senza nome"}
                subtitle={`${describe(s)}${who ? ` · ${who}` : ""}`}
                leading={s.kind === "monster" ? <Skull size={18} /> : <UserRound size={18} />}
                trailing={token ? <Badge tone="tint">{token}</Badge> : undefined}
                chevron
                onPress={() => opened(s.id)}
              />
            );
          })}
        </List>
      )}

      <Sheet open={creating === "pc"} onOpenChange={(o) => !o && setCreating(null)} title="Nuovo personaggio">
        <form
          className="s-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || busy) return;
            void run(() =>
              createSheet(campaignId, {
                kind: "pc",
                doc: blankDoc(name.trim()),
                ...(isGm && owner !== "none" ? { ownerUserId: owner } : {})
              })
            );
          }}
        >
          <TextField label="Nome del personaggio" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required autoFocus />
          {isGm ? (
            <Picker
              label="Giocatore proprietario"
              value={owner}
              onValueChange={setOwner}
              options={[{ value: "none", label: "Nessuno" }, ...members.filter((m) => m.role === "player").map((m) => ({ value: m.userId, label: m.displayName }))]}
            />
          ) : null}
          <Button type="submit" loading={busy} fullWidth>
            Crea
          </Button>
        </form>
      </Sheet>

      <Sheet open={creating === "monster-library"} onOpenChange={(o) => !o && setCreating(null)} title="Mostro dalla libreria">
        <div className="s-stack">
          <LibraryPicker
            kind="monster"
            actionLabel="Crea scheda"
            onPick={(d) => run(() => createSheet(campaignId, { kind: "monster", doc: monsterDocFromContent(d.name, d.data, d.id) }))}
          />
          <Button
            variant="gray"
            onClick={() => void run(() => createSheet(campaignId, { kind: "monster", doc: blankDoc("Nuovo mostro", "monster") }))}
            loading={busy}
          >
            Statblock vuoto
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
