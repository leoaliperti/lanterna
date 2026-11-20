import { useCallback, useEffect, useRef, useState } from "react";
import { Library, Plus, Trash2 } from "lucide-react";
import type { CampaignView, LibraryItem, SceneView, TokenView } from "@lanterna/shared";
import { Alert, Avatar, Badge, Banner, Button, IconButton, List, ListRow, SearchField, SegmentedControl, Spinner, useToast } from "../ui";
import { userErrorMessage } from "../api/client";
import { assetUrl } from "../realtime/urls";
import { useCommands } from "../realtime/RealtimeProvider";
import { EmptyState } from "../screens/EmptyState";
import { permissionsFor } from "../table/permissions";
import { deleteLibraryItem, hasStats, listLibrary, type AnyLibraryItem } from "./libraryApi";
import { KIND_LABEL, instanceCommand } from "./libraryLogic";

type Filter = "all" | "pc" | "monster" | "object";

/** Evento che il resto del client emette quando la libreria cambia (es. "Salva nella libreria" dall'editor). */
export const LIBRARY_CHANGED = "lanterna:library-changed";

export interface LibraryPanelProps {
  view: CampaignView;
  /** Scena in cui si creano le istanze (quella mostrata). */
  scene: SceneView | null;
  tokens: readonly TokenView[];
  /** Dopo aver aggiunto un'istanza (es. per chiudere lo sheet su telefono). */
  onAdded?: () => void;
}

/**
 * Libreria di token e oggetti riutilizzabili. Il GM cerca, filtra e con un clic crea un'istanza sulla scena
 * (comando `token.create`: il server decide); il giocatore vede in sola lettura solo i tipi che il server gli
 * concede (di default nessuno) e senza statistiche.
 */
export function LibraryPanel({ view, scene, tokens, onAdded }: LibraryPanelProps) {
  const perms = permissionsFor(view);
  const { run } = useCommands();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; items: AnyLibraryItem[]; total: number }>({ status: "loading" });
  const [reload, setReload] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<LibraryItem | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const on = () => setReload((n) => n + 1);
    window.addEventListener(LIBRARY_CHANGED, on);
    return () => window.removeEventListener(LIBRARY_CHANGED, on);
  }, []);

  // Ricerca con un breve ritardo; una risposta vecchia non sovrascrive una piu' recente.
  useEffect(() => {
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      listLibrary({ campaignId: view.campaignId, q: query, kind: filter }).then(
        (res) => mine === seq.current && setState({ status: "ready", items: res.items, total: res.total }),
        (err: unknown) => mine === seq.current && setState({ status: "error", message: userErrorMessage(err) })
      );
    }, query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [view.campaignId, query, filter, reload]);

  const add = useCallback(
    async (item: LibraryItem) => {
      if (!scene) return;
      const ok = await run(instanceCommand(item, scene, tokens.filter((t) => t.sceneId === scene.id), crypto.randomUUID()));
      if (ok) {
        toast.show({ title: `${item.name} aggiunto alla scena`, tone: "success" });
        onAdded?.();
      }
    },
    [run, scene, tokens, toast, onAdded]
  );

  const remove = useCallback(
    async (item: LibraryItem) => {
      try {
        await deleteLibraryItem(item.id);
        setReload((n) => n + 1);
        toast.show({ title: `${item.name} tolto dalla libreria`, tone: "success" });
      } catch (err) {
        toast.show({ title: "Impossibile eliminare", message: userErrorMessage(err), tone: "danger" });
      }
    },
    [toast]
  );

  const subtitle = (i: AnyLibraryItem) =>
    [KIND_LABEL[i.kind], i.size === 1 ? "1 cella" : `${i.size} celle`, ...(hasStats(i) && i.stats.hpMax !== null ? [`PF ${i.stats.hpMax}`] : [])].join(" · ");

  return (
    <div className="a-panel">
      <SearchField placeholder="Cerca nella libreria" label="Cerca nella libreria" value={query} onValueChange={setQuery} />
      <SegmentedControl
        aria-label="Tipo"
        value={filter}
        onValueChange={setFilter}
        options={[
          { value: "all", label: "Tutti" },
          { value: "pc", label: "PG" },
          { value: "monster", label: "Mostri" },
          { value: "object", label: "Oggetti" }
        ]}
      />
      {state.status === "loading" ? (
        <Spinner label="Caricamento della libreria" />
      ) : state.status === "error" ? (
        <Banner tone="danger" title="Non riesco a caricare la libreria">
          {state.message}
        </Banner>
      ) : state.items.length === 0 ? (
        query || filter !== "all" ? (
          <p className="t-subhead a-muted a-panel__none" role="status">
            Nessun elemento corrisponde alla ricerca.
          </p>
        ) : (
          <EmptyState
            icon={<Library size={28} />}
            title="Libreria vuota"
            description={
              perms.isGm
                ? "Apri un token e scegli \"Salva nella libreria\": potrai rimetterlo in scena con un clic."
                : "Il GM non ha condiviso elementi con te."
            }
          />
        )
      ) : (
        <List aria-label="Elementi della libreria">
          {state.items.map((item) => (
            <ListRow
              key={item.id}
              title={item.name}
              subtitle={subtitle(item)}
              leading={<Avatar name={item.name} src={assetUrl(item.imageUrl)} size="sm" />}
              trailing={
                <span className="a-row-meta">
                  {item.scope === "global" ? <Badge tone="gray">Globale</Badge> : null}
                  {perms.isGm && hasStats(item) ? (
                    <>
                      <IconButton label={`Elimina ${item.name} dalla libreria`} icon={<Trash2 size={16} />} onClick={() => setConfirmDelete(item)} />
                      <Button size="sm" icon={<Plus size={14} />} disabled={!scene} aria-label={`Aggiungi ${item.name} alla scena`} onClick={() => void add(item)}>
                        Aggiungi
                      </Button>
                    </>
                  ) : null}
                </span>
              }
            />
          ))}
        </List>
      )}
      {perms.isGm && !scene ? <p className="t-caption1 a-muted">Per aggiungere elementi serve una scena.</p> : null}
      <Alert
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title="Eliminare dalla libreria?"
        message="I token già in scena non cambiano."
        actions={[
          { label: "Annulla", role: "cancel" },
          {
            label: "Elimina",
            role: "destructive",
            onPress: () => {
              if (confirmDelete) void remove(confirmDelete);
            }
          }
        ]}
      />
    </div>
  );
}
