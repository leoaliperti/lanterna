import { LIMITS, type Command, type Prop, type PropLayer, type PropPatch, type PropView, type SceneView } from "@lanterna/shared";

export const LAYER_LABELS: Record<PropLayer, string> = { background: "Sfondo", ground: "A terra", above: "Sopra" };

/** Lato maggiore di un oggetto nuovo, in celle: un albero o un tappeto si ridimensionano poi. */
const NEW_PROP_CELLS = 3;

/** Nuovo oggetto dal file caricato: al centro della scena, con le proporzioni dell'immagine. */
export function newProp(input: { id: string; name: string; url: string; imageWidth: number; imageHeight: number; layer: PropLayer }, scene: SceneView): Prop {
  const target = scene.grid.cellSize * NEW_PROP_CELLS;
  const k = Math.min(1, target / Math.max(input.imageWidth, input.imageHeight, 1));
  return {
    id: input.id,
    sceneId: scene.id,
    name: input.name.trim().slice(0, LIMITS.nameMaxLength) || "Oggetto",
    imageUrl: input.url,
    x: Math.round(scene.width / 2),
    y: Math.round(scene.height / 2),
    width: Math.max(1, Math.round(input.imageWidth * k)),
    height: Math.max(1, Math.round(input.imageHeight * k)),
    rotation: 0,
    layer: input.layer,
    opacity: 1,
    fade: input.layer === "above",
    hidden: false
  };
}

/** Valori del modulo di modifica (testo, per non perdere quello che l'utente sta digitando). */
export interface PropDraft {
  name: string;
  layer: PropLayer;
  x: string;
  y: string;
  width: string;
  height: string;
  rotation: string;
  opacity: number;
  fade: boolean;
  hidden: boolean;
}

export function draftOfProp(p: PropView): PropDraft {
  return {
    name: p.name ?? "",
    layer: p.layer,
    x: String(Math.round(p.x)),
    y: String(Math.round(p.y)),
    width: String(Math.round(p.width)),
    height: String(Math.round(p.height)),
    rotation: String(Math.round(p.rotation)),
    opacity: p.opacity,
    fade: p.fade,
    hidden: p.hidden ?? false
  };
}

function num(text: string, min: number, max: number): number | null {
  const n = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** Comando `prop.update` con i soli campi cambiati; `null` se non valido o senza modifiche. */
export function updateCommand(p: PropView, d: PropDraft, scene: Pick<SceneView, "width" | "height">): Command | null {
  const x = num(d.x, 0, scene.width);
  const y = num(d.y, 0, scene.height);
  const width = num(d.width, 1, LIMITS.sceneMaxSize);
  const height = num(d.height, 1, LIMITS.sceneMaxSize);
  const rot = num(d.rotation, -3600, 3600);
  const name = d.name.trim();
  if (x === null || y === null || width === null || height === null || rot === null || name === "" || name.length > LIMITS.nameMaxLength) return null;
  const rotation = ((rot % 360) + 360) % 360;
  const patch: PropPatch = {};
  if (name !== p.name) patch.name = name;
  if (d.layer !== p.layer) patch.layer = d.layer;
  if (x !== p.x) patch.x = x;
  if (y !== p.y) patch.y = y;
  if (width !== p.width) patch.width = width;
  if (height !== p.height) patch.height = height;
  if (rotation !== p.rotation) patch.rotation = rotation;
  if (d.opacity !== p.opacity) patch.opacity = d.opacity;
  if (d.fade !== p.fade) patch.fade = d.fade;
  if (d.hidden !== (p.hidden ?? false)) patch.hidden = d.hidden;
  return Object.keys(patch).length > 0 ? { type: "prop.update", propId: p.id, patch } : null;
}
