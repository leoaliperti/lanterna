import { useState } from "react";
import { Eye, Layers, Plus, Settings2, Trash2 } from "lucide-react";
import type { CampaignView, SceneView } from "@lanterna/shared";
import { Alert, Badge, Button, List, ListRow } from "../ui";
import { useCommands } from "../realtime/RealtimeProvider";
import { EmptyState } from "../screens/EmptyState";
import { SceneForm } from "./SceneForm";

export interface ScenePanelProps {
  view: CampaignView;
  /** Scena che il GM sta guardando (puo' essere diversa da quella attiva per i giocatori). */
  shown: SceneView | null;
  onShow: (sceneId: string) => void;
}

/** Elenco delle scene e strumenti del GM: cambio scena, creazione, impostazioni, eliminazione. */
export function ScenePanel({ view, shown, onShow }: ScenePanelProps) {
  const { run } = useCommands();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const activeId = view.activeSceneId;

  async function activate(id: string | null) {
    setBusy(true);
    try {
      await run({ type: "scene.activate", sceneId: id });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="a-panel">
      <div className="a-panel__bar">
        <Button size="sm" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
          Nuova scena
        </Button>
      </div>

      {view.scenes.length === 0 ? (
        <EmptyState icon={<Layers size={28} />} title="Nessuna scena" description="Crea la prima scena, poi carica una mappa e aggiungi i token." />
      ) : (
        <List header="Scene" aria-label="Scene">
          {view.scenes.map((s) => (
            <ListRow
              key={s.id}
              title={s.name}
              subtitle={s.id === activeId ? "Visibile ai giocatori" : s.id === shown?.id ? "La stai guardando" : undefined}
              trailing={s.id === activeId ? <Badge tone="green">In gioco</Badge> : undefined}
              selected={s.id === shown?.id}
              onPress={() => onShow(s.id)}
            />
          ))}
        </List>
      )}

      {shown ? (
        <div className="a-panel__section">
          <p className="t-footnote a-muted">Scena: {shown.name}</p>
          <div className="a-panel__buttons">
            {shown.id !== activeId ? (
              <Button variant="tinted" size="sm" icon={<Eye size={16} />} loading={busy} onClick={() => void activate(shown.id)}>
                Mostra ai giocatori
              </Button>
            ) : (
              <Button variant="gray" size="sm" loading={busy} onClick={() => void activate(null)}>
                Togli ai giocatori
              </Button>
            )}
            <Button variant="gray" size="sm" icon={<Settings2 size={16} />} onClick={() => setEditing(true)}>
              Mappa e griglia
            </Button>
            <Button variant="destructive" size="sm" icon={<Trash2 size={16} />} onClick={() => setConfirmDelete(true)}>
              Elimina
            </Button>
          </div>
        </div>
      ) : null}

      <SceneForm
        open={creating}
        onOpenChange={setCreating}
        scene={null}
        onCreated={(id) => {
          onShow(id);
        }}
      />
      <SceneForm open={editing && shown !== null}onOpenChange={setEditing} scene={shown} />
      <Alert
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Eliminare la scena?"
        message={`"${shown?.name ?? ""}" e tutti i suoi token verranno eliminati. Puoi annullare subito dopo con Annulla (Cmd/Ctrl+Z).`}
        actions={[
          { label: "Annulla", role: "cancel" },
          {
            label: "Elimina",
            role: "destructive",
            onPress: () => {
              if (shown) void run({ type: "scene.delete", sceneId: shown.id });
            }
          }
        ]}
      />
    </div>
  );
}
