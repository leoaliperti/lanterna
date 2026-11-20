import type { CampaignView, SceneView, TokenView } from "@lanterna/shared";
import type { MapScene, MapToken, TokenKind as MapTokenKind } from "../map";
import { assetUrl } from "../realtime/urls";

/**
 * Adattatore stato condiviso -> props di `MapCanvas`. Mostra esattamente cio' che il server ha
 * inviato: non filtra e non nasconde nulla (la vita c'e' solo se `health` non e' null, i token
 * nascosti arrivano solo al GM, e il canvas li disegna semitrasparenti solo con role "gm").
 */

/** Immagine trasparente 1x1: il canvas vuole sempre uno sfondo, una scena senza mappa ha solo la griglia. */
export const BLANK_BACKGROUND_URL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const KIND_MAP: Record<TokenView["kind"], MapTokenKind> = { pc: "character", monster: "monster", object: "object" };

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

const KIND_HUE: Record<TokenView["kind"], number> = { pc: 212, monster: 4, object: 38 };

/** Colore di riempimento di un token senza immagine: dal tipo, con una variazione stabile dall'id. */
export function tokenColor(token: Pick<TokenView, "id" | "kind">): string {
  const variation = (hash(token.id) % 41) - 20;
  return hslToHex((KIND_HUE[token.kind] + variation + 360) % 360, 0.62, 0.5);
}

/** Scena da mostrare: per il GM quella scelta da lui (se esiste), altrimenti quella attiva. */
export function sceneToShow(view: CampaignView, viewedSceneId: string | null = null): SceneView | null {
  const id = view.viewer.role === "admin" && viewedSceneId ? viewedSceneId : view.activeSceneId;
  if (!id) return null;
  return view.scenes.find((s) => s.id === id) ?? (view.viewer.role === "admin" ? (view.scenes.find((s) => s.id === view.activeSceneId) ?? null) : null);
}

export function tokensOfScene(view: CampaignView, sceneId: string): TokenView[] {
  return view.tokens.filter((t) => t.sceneId === sceneId);
}

/** Token che l'utente puo' trascinare: il GM tutti, il giocatore solo i propri. Il server verifica comunque. */
export function movableIds(view: CampaignView, sceneId: string): string[] {
  const mine = view.viewer.userId;
  return tokensOfScene(view, sceneId)
    .filter((t) => view.viewer.role === "admin" || t.ownerUserId === mine)
    .map((t) => t.id);
}

export function toMapToken(token: TokenView): MapToken {
  const url = assetUrl(token.imageUrl);
  return {
    id: token.id,
    x: token.x,
    y: token.y,
    size: token.size,
    rotation: token.rotation,
    imageUrl: url,
    color: url ? undefined : tokenColor(token),
    label: token.name,
    kind: KIND_MAP[token.kind],
    hidden: token.hidden,
    conditions: token.conditions.map((c) => ({ id: c.id, label: c.name })),
    // Solo se il server l'ha inviata (GM e proprietario): mai dedotta dal client.
    health: token.health ? { current: token.health.current, max: token.health.max, temp: token.health.temp } : undefined
  };
}

export function toMapScene(view: CampaignView, scene: SceneView): MapScene {
  return {
    background: {
      url: scene.map ? (assetUrl(scene.map.url) ?? BLANK_BACKGROUND_URL) : BLANK_BACKGROUND_URL,
      width: scene.width,
      height: scene.height
    },
    grid: { ...scene.grid },
    scale: { unitsPerCell: scene.scale.unitsPerCell, unitLabel: scene.scale.unit },
    tokens: tokensOfScene(view, scene.id).map(toMapToken),
    role: view.viewer.role === "admin" ? "gm" : "player",
    movableTokenIds: movableIds(view, scene.id)
  };
}
