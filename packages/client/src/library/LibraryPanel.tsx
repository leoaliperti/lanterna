import { useCallback, useEffect, useRef, useState } from "react";
import { Library, Plus, Trash2 } from "lucide-react";
import type { CampaignView, LibraryItem, SceneView, TokenView } from "@lanterna/shared";
import { Alert, Avatar, Badge, Banner, Button, IconButton, List, ListRow, SearchField, SegmentedControl, Sheet, Spinner, useToast } from "../ui";
import { userErrorMessage } from "../api/client";
import { assetUrl } from "../realtime/urls";
import { useCommands } from "../realtime/RealtimeProvider";
import { EmptyState } from "../screens/EmptyState";
import { permissionsFor } from "../table/permissions";
import { LibraryPicker } from "../sheets/LibraryPicker";
import { deleteLibraryItem, hasStats, listLibrary, updateLibraryItem, type AnyLibraryItem } from "./libraryApi";
import { KIND_LABEL, LIBRARY_DRAG_TYPE, instanceCommand, setDraggedItem } from "./libraryLogic";
import { createLinkedSheet } from "./linkedSheet";

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
  // Elemento a cui si sta collegando una scheda (un mostro importato).
  const [linking, setLinking] = useState<LibraryItem | null>(null);
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
      const id = crypto.randomUUID();
      const ok = await run(instanceCommand(item, scene, tokens.filter((t) => t.sceneId === scene.id), id));
      if (ok) {
        toast.show({ title: `${item.name} aggiunto alla scena`, tone: "success" });
        onAdded?.();
        try {
          await createLinkedSheet(view.campaignId, item, id);
        } catch (err) {
          toast.show({ title: "Token aggiunto, ma la scheda non è stata creata", message: userErrorMessage(err), tone: "danger" });
        }
      }
    },
    [run, scene, tokens, toast, onAdded, view.campaignId]
  );

  const link = useCallback(
    async (item: LibraryItem, contentId: string | null) => {
      try {
        await updateLibraryItem(item.id, { contentId });
        setReload((n) => n + 1);
        toast.show({ title: contentId ? `Scheda collegata a ${item.name}` : `Scheda scollegata da ${item.name}`, tone: "success" });
      } catch (err) {
        toast.show({ title: "Impossibile collegare la scheda", message: userErrorMessage(err), tone: "danger" });
      }
    },
    [toast]
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
    [
      KIND_LABEL[i.kind],
      i.size === 1 ? "1 cella" : `${i.size} celle`,
      ...(hasStats(i) && i.stats.hpMax !== null ? [`PF ${i.stats.hpMax}`] : []),
      ...(hasStats(i) && i.contentId ? ["scheda collegata"] : []),
    ].join(" · ");

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
              onDragStart={
                perms.isGm && hasStats(item) && scene
                  ? (e) => {
                      e.dataTransfer.setData(LIBRARY_DRAG_TYPE, item.id);
                      e.dataTransfer.effectAllowed = "copy";
                      setDraggedItem(item);
                    }
                  : undefined
              }
              leading={<Avatar name={item.name} src={assetUrl(item.imageUrl)} size="sm" />}
              trailing={
                <span className="a-row-meta">
                  {item.scope === "global" ? <Badge tone="gray">Globale</Badge> : null}
                  {perms.isGm && hasStats(item) ? (
                    <>
                      {item.kind === "monster" ? (
                        <Button size="sm" variant="gray" onClick={() => setLinking(item)} aria-label={`Collega la scheda a ${item.name}`}>
                          {item.contentId ? "Cambia scheda" : "Collega scheda"}
                        </Button>
                      ) : null}
                      {item.kind === "monster" && item.contentId ? (
                        <Button size="sm" variant="plain" onClick={() => void link(item, null)} aria-label={`Scollega la scheda da ${item.name}`}>
                          Scollega
                        </Button>
                      ) : null}
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
      <Sheet open={linking !== null} onOpenChange={(open) => !open && setLinking(null)} title="Scheda del mostro">
        {linking ? (
          <LibraryPicker
            kind="monster"
            actionLabel="Collega"
            onPick={async (doc) => {
              const item = linking;
              setLinking(null);
              await link(item, doc.id);
            }}
          />
        ) : null}
      </Sheet>
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
