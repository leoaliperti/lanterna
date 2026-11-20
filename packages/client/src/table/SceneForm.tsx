import { useEffect, useState } from "react";
import { DEFAULT_GRID, DEFAULT_SCALE, LIMITS, type Command, type SceneView } from "@lanterna/shared";
import { uploadErrorMessage, uploadImage } from "../api/client";
import { Button, Sheet, Slider, TextField, Toggle } from "../ui";
import { assetUrl } from "../realtime/urls";
import { useCommands } from "../realtime/RealtimeProvider";
import { ImagePicker } from "./ImagePicker";
import { NumberField, parseNumber } from "./NumberField";

export interface SceneFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` = nuova scena. */
  scene: SceneView | null;
  /** Dopo la creazione di una nuova scena (per mostrarla al GM). */
  onCreated?: (sceneId: string) => void;
}

const DEFAULT_SIZE = { width: 2100, height: 1500 };

interface Draft {
  name: string;
  cellSize: string;
  offsetX: string;
  offsetY: string;
  color: string;
  opacity: number;
  snap: boolean;
  visible: boolean;
  unitsPerCell: string;
  unit: string;
}

function draftOf(scene: SceneView | null): Draft {
  const g = scene?.grid ?? DEFAULT_GRID;
  const s = scene?.scale ?? DEFAULT_SCALE;
  return {
    name: scene?.name ?? "",
    cellSize: String(g.cellSize),
    offsetX: String(g.offsetX),
    offsetY: String(g.offsetY),
    color: g.color,
    opacity: g.opacity,
    snap: g.snap,
    visible: g.visible,
    unitsPerCell: String(s.unitsPerCell),
    unit: s.unit
  };
}

function newId(): string {
  return crypto.randomUUID();
}

/** Crea una scena o modifica nome, mappa, griglia e scala di quella scelta. Solo GM (il server rifiuta gli altri). */
export function SceneForm({ open, onOpenChange, scene, onCreated }: SceneFormProps) {
  const { run } = useCommands();
  const [draft, setDraft] = useState<Draft>(() => draftOf(scene));
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(draftOf(scene));
      setFile(null);
      setUploadError(null);
      setSubmitted(false);
      setBusy(false);
    }
  }, [open, scene]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const cell = parseNumber(draft.cellSize, LIMITS.cellMinSize, LIMITS.cellMaxSize);
  const offX = parseNumber(draft.offsetX, -LIMITS.cellMaxSize, LIMITS.cellMaxSize);
  const offY = parseNumber(draft.offsetY, -LIMITS.cellMaxSize, LIMITS.cellMaxSize);
  const units = parseNumber(draft.unitsPerCell, Number.MIN_VALUE, LIMITS.unitsPerCellMax);
  const errors = {
    name: draft.name.trim() === "" ? "Dai un nome alla scena." : draft.name.trim().length > LIMITS.nameMaxLength ? "Nome troppo lungo." : null,
    cell: cell === null ? `Tra ${LIMITS.cellMinSize} e ${LIMITS.cellMaxSize} pixel.` : null,
    offX: offX === null || (cell !== null && Math.abs(offX) >= cell) ? "Deve essere minore della cella." : null,
    offY: offY === null || (cell !== null && Math.abs(offY) >= cell) ? "Deve essere minore della cella." : null,
    units: units === null ? "Un numero maggiore di zero." : null,
    unit: draft.unit.trim() === "" || draft.unit.trim().length > LIMITS.unitMaxLength ? "Da 1 a 16 caratteri." : null
  };
  const valid = Object.values(errors).every((e) => e === null);
  const show = (e: string | null) => (submitted ? e : null);

  async function submit() {
    setSubmitted(true);
    if (!valid || cell === null || offX === null || offY === null || units === null) return;
    setBusy(true);
    setUploadError(null);
    try {
      let map: { assetId: string; url: string } | null | undefined;
      let size: { width: number; height: number } | undefined;
      if (file) {
        try {
          const up = await uploadImage("map", file);
          map = { assetId: up.assetId, url: up.url };
          size = { width: up.width, height: up.height };
        } catch (err) {
          setUploadError(uploadErrorMessage(err));
          return;
        }
      }
      const grid = { cellSize: cell, offsetX: offX, offsetY: offY, color: draft.color, opacity: draft.opacity, snap: draft.snap, visible: draft.visible };
      const scale = { unitsPerCell: units, unit: draft.unit.trim() };
      const name = draft.name.trim();

      if (!scene) {
        const id = newId();
        const ok = await run({
          type: "scene.create",
          scene: { id, name, map: map ?? null, width: size?.width ?? DEFAULT_SIZE.width, height: size?.height ?? DEFAULT_SIZE.height, grid, scale }
        });
        if (ok) {
          onCreated?.(id);
          onOpenChange(false);
        }
        return;
      }

      const commands: Command[] = [];
      const patch: Record<string, unknown> = {};
      if (name !== scene.name) patch.name = name;
      if (map && size) Object.assign(patch, { map, width: size.width, height: size.height });
      if (scale.unitsPerCell !== scene.scale.unitsPerCell || scale.unit !== scene.scale.unit) patch.scale = scale;
      if (Object.keys(patch).length > 0) commands.push({ type: "scene.update", sceneId: scene.id, patch });
      const gridPatch = Object.fromEntries(Object.entries(grid).filter(([k, v]) => scene.grid[k as keyof typeof scene.grid] !== v));
      if (Object.keys(gridPatch).length > 0) commands.push({ type: "scene.setGrid", sceneId: scene.id, grid: gridPatch });
      for (const c of commands) {
        if (!(await run(c))) return;
      }
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={scene ? "Impostazioni della scena" : "Nuova scena"}>
      <form
        className="a-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField label="Nome della scena" value={draft.name} onChange={(e) => set("name", e.target.value)} error={show(errors.name) ?? undefined} maxLength={LIMITS.nameMaxLength + 10} autoComplete="off" />
        <ImagePicker
          label="Mappa"
          file={file}
          onFileChange={setFile}
          currentUrl={scene?.map ? assetUrl(scene.map.url) : undefined}
          error={uploadError}
          disabled={busy}
          helper="PNG, JPEG o WebP, fino a 25 MB. Le dimensioni della scena seguono quelle dell'immagine."
        />

        <h3 className="t-headline a-form__section">Griglia</h3>
        <NumberField label="Lato della cella (pixel)" value={draft.cellSize} onValueChange={(v) => set("cellSize", v)} min={LIMITS.cellMinSize} max={LIMITS.cellMaxSize} error={show(errors.cell)} />
        <div className="a-form__pair">
          <NumberField label="Spostamento orizzontale" value={draft.offsetX} onValueChange={(v) => set("offsetX", v)} error={show(errors.offX)} />
          <NumberField label="Spostamento verticale" value={draft.offsetY} onValueChange={(v) => set("offsetY", v)} error={show(errors.offY)} />
        </div>
        <TextField label="Colore della griglia" type="color" value={draft.color} onChange={(e) => set("color", e.target.value)} />
        <div className="a-field-group">
          <span className="t-footnote a-muted" id="grid-opacity">Opacita': {Math.round(draft.opacity * 100)}%</span>
          <Slider aria-label="Opacita' della griglia" value={draft.opacity} onValueChange={(v) => set("opacity", v)} min={0} max={1} step={0.05} />
        </div>
        <Toggle label="Mostra la griglia" checked={draft.visible} onCheckedChange={(v) => set("visible", v)} />
        <Toggle label="Aggancia i token alla cella" checked={draft.snap} onCheckedChange={(v) => set("snap", v)} />

        <h3 className="t-headline a-form__section">Scala</h3>
        <div className="a-form__pair">
          <NumberField label="Una cella vale" value={draft.unitsPerCell} onValueChange={(v) => set("unitsPerCell", v)} step={0.5} error={show(errors.units)} />
          <TextField label="Unita'" value={draft.unit} onChange={(e) => set("unit", e.target.value)} error={show(errors.unit) ?? undefined} autoComplete="off" />
        </div>

        <div className="a-form__actions">
          <Button variant="gray" onClick={() => onOpenChange(false)} disabled={busy}>
            Annulla
          </Button>
          <Button type="submit" loading={busy}>
            {scene ? "Applica" : "Crea scena"}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
