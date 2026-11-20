import type { Command, CreateLibraryItem, LibraryItem, Token } from "@lanterna/shared";
import { spawnPoint, type TokenDraft } from "../table/tokenDraft";

/** Logica pura della libreria: cosa si salva dall'editor dei token e come si crea un'istanza in scena. */

export const KIND_LABEL: Record<LibraryItem["kind"], string> = { pc: "Personaggio", monster: "Mostro", object: "Oggetto" };

/** Corpo di `POST /library` a partire da ciò che si vede nell'editor del token. */
export function libraryInputFromDraft(
  d: Pick<TokenDraft, "name" | "kind" | "size" | "hasHealth" | "max">,
  imageUrl: string | null,
  scope: { kind: "campaign"; campaignId: string } | { kind: "global" }
): CreateLibraryItem {
  const hp = d.hasHealth ? Math.trunc(Number(d.max)) : NaN;
  return {
    name: d.name.trim(),
    kind: d.kind,
    size: d.size,
    imageUrl,
    stats: { hpMax: Number.isFinite(hp) && hp >= 0 ? hp : null, armorClass: null, speed: null },
    tags: [],
    ...(scope.kind === "campaign" ? { scope: "campaign" as const, campaignId: scope.campaignId } : { scope: "global" as const })
  };
}

/**
 * Comando `token.create` per un'istanza di un elemento della libreria: id nuovo, posizione libera vicino al
 * centro della scena, punti ferita al massimo se l'elemento ne ha. Il server rivalida tutto.
 */
export function instanceCommand(
  item: LibraryItem,
  scene: { id: string; width: number; height: number; grid: { cellSize: number; offsetX: number; offsetY: number } },
  taken: ReadonlyArray<{ x: number; y: number }>,
  id: string
): Command {
  const at = spawnPoint(scene, item.size, taken);
  const hp = item.stats.hpMax;
  const token: Token = {
    id,
    sceneId: scene.id,
    name: item.name,
    imageUrl: item.imageUrl,
    x: at.x,
    y: at.y,
    size: item.size,
    rotation: 0,
    ownerUserId: null,
    kind: item.kind,
    hidden: false,
    conditions: [],
    health: hp !== null && hp > 0 ? { current: hp, max: hp, temp: 0 } : null,
    gmNotes: ""
  };
  return { type: "token.create", token };
}
