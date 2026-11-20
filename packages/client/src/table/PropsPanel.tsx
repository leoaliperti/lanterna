import { useEffect, useState } from "react";
import { Plus, Shapes, Trash2 } from "lucide-react";
import type { CampaignView, PropLayer, PropView, SceneView } from "@lanterna/shared";
import { uploadErrorMessage, uploadImage } from "../api/client";
import { useCommands } from "../realtime/RealtimeProvider";
import { EmptyState } from "../screens/EmptyState";
import { Badge, Button, List, ListRow, SegmentedControl, Sheet, Slider, TextField, Toggle } from "../ui";
import { ImagePicker } from "./ImagePicker";
import { NumberField } from "./NumberField";
import { LAYER_LABELS, draftOfProp, newProp, updateCommand, type PropDraft } from "./propDraft";

const LAYER_OPTIONS = (Object.keys(LAYER_LABELS) as PropLayer[]).map((value) => ({ value, label: LAYER_LABELS[value] }));

export interface PropsPanelProps {
  view: CampaignView;
  scene: SceneView;
}

/** Oggetti di scena della scena mostrata (solo GM): aggiunta da un'immagine, livello, posizione e dimensioni. */
export function PropsPanel({ view, scene }: PropsPanelProps) {
  const { run } = useCommands();
  const [adding, setAdding] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const props = (view.props ?? []).filter((p) => p.sceneId === scene.id);
  const selected = props.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="a-panel">
      <div className="a-panel__bar">
        <Button size="sm" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
          Aggiungi oggetto
        </Button>
      </div>
      <p className="t-footnote a-muted">I token stanno fra "A terra" e "Sopra". Gli oggetti "Sopra" con dissolvenza si schiariscono quando un token ci passa sotto.</p>
      {props.length === 0 ? (
        <EmptyState icon={<Shapes size={28} />} title="Nessun oggetto" description="Aggiungi un albero, un tetto o un tappeto da un'immagine PNG, JPEG o WebP." />
      ) : (
        <List header="Oggetti" aria-label="Oggetti di scena">
          {props.map((p) => (
            <ListRow
              key={p.id}
              title={p.name ?? "Oggetto"}
              subtitle={LAYER_LABELS[p.layer]}
              trailing={p.hidden ? <Badge tone="gray">Nascosto</Badge> : undefined}
              selected={p.id === selectedId}
              onPress={() => setSelectedId(p.id === selectedId ? null : p.id)}
            />
          ))}
        </List>
      )}
      {selected ? <PropEditor key={selected.id} prop={selected} scene={scene} onDeleted={() => setSelectedId(null)} /> : null}
      <AddPropSheet open={adding} onOpenChange={setAdding} scene={scene} onCreated={setSelectedId} run={run} />
    </div>
  );
}

function PropEditor({ prop, scene, onDeleted }: { prop: PropView; scene: SceneView; onDeleted: () => void }) {
  const { run } = useCommands();
  const [draft, setDraft] = useState<PropDraft>(() => draftOfProp(prop));
  const [submitted, setSubmitted] = useState(false);
  // Se l'oggetto cambia dal server (annulla, altra finestra) il modulo riparte da li'.
  useEffect(() => setDraft(draftOfProp(prop)), [prop]);
  const set = <K extends keyof PropDraft>(k: K, v: PropDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const command = updateCommand(prop, draft, scene);

  return (
    <form
      className="a-form a-panel__section"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
        if (command) void run(command);
      }}
    >
      <TextField label="Nome (solo per te)" value={draft.name} onChange={(e) => set("name", e.target.value)} maxLength={64} autoComplete="off" />
      <SegmentedControl aria-label="Livello" options={LAYER_OPTIONS} value={draft.layer} onValueChange={(v) => set("layer", v)} />
      <div className="a-form__pair">
        <NumberField label="Centro X" value={draft.x} onValueChange={(v) => set("x", v)} />
        <NumberField label="Centro Y" value={draft.y} onValueChange={(v) => set("y", v)} />
      </div>
      <div className="a-form__pair">
        <NumberField label="Larghezza" value={draft.width} onValueChange={(v) => set("width", v)} min={1} />
        <NumberField label="Altezza" value={draft.height} onValueChange={(v) => set("height", v)} min={1} />
      </div>
      <NumberField label="Rotazione (gradi)" value={draft.rotation} onValueChange={(v) => set("rotation", v)} />
      <div className="a-field-group">
        <span className="t-footnote a-muted">Opacità: {Math.round(draft.opacity * 100)}%</span>
        <Slider aria-label="Opacità dell'oggetto" value={draft.opacity} onValueChange={(v) => set("opacity", v)} min={0} max={1} step={0.05} />
      </div>
      <Toggle label="Si schiarisce quando un token ci passa sotto" checked={draft.fade} onCheckedChange={(v) => set("fade", v)} />
      <Toggle label="Nascosto ai giocatori" checked={draft.hidden} onCheckedChange={(v) => set("hidden", v)} />
      {submitted && !command ? <p className="t-footnote a-muted">Nessuna modifica valida da applicare.</p> : null}
      <div className="a-form__actions">
        <Button
          variant="destructive"
          icon={<Trash2 size={16} />}
          onClick={() => {
            void run({ type: "prop.delete", propId: prop.id }).then((ok) => ok && onDeleted());
          }}
        >
          Elimina
        </Button>
        <Button type="submit" disabled={!command}>
          Applica
        </Button>
      </div>
    </form>
  );
}

function AddPropSheet({
  open,
  onOpenChange,
  scene,
  onCreated,
  run
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scene: SceneView;
  onCreated: (id: string) => void;
  run: ReturnType<typeof useCommands>["run"];
}) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [layer, setLayer] = useState<PropLayer>("above");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setFile(null);
      setName("");
      setLayer("above");
      setBusy(false);
      setError(null);
    }
  }, [open]);

  async function submit() {
    if (!file) {
      setError("Scegli un'immagine.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let up;
      try {
        up = await uploadImage("map", file);
      } catch (err) {
        setError(uploadErrorMessage(err));
        return;
      }
      const id = crypto.randomUUID();
      const label = name.trim() || file.name.replace(/\.[^.]+$/, "");
      const prop = newProp({ id, name: label, url: up.url, imageWidth: up.width, imageHeight: up.height, layer }, scene);
      if (await run({ type: "prop.create", prop })) {
        onCreated(id);
        onOpenChange(false);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Nuovo oggetto">
      <form
        className="a-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <ImagePicker label="Immagine" file={file} onFileChange={setFile} error={error} disabled={busy} helper="PNG, JPEG o WebP. Con trasparenza va bene per alberi e tetti." />
        <TextField label="Nome (solo per te)" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoComplete="off" />
        <SegmentedControl aria-label="Livello" options={LAYER_OPTIONS} value={layer} onValueChange={setLayer} />
        <div className="a-form__actions">
          <Button variant="gray" onClick={() => onOpenChange(false)} disabled={busy}>
            Annulla
          </Button>
          <Button type="submit" loading={busy}>
            Aggiungi
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
