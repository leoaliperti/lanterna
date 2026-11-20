/**
 * Viste del tavolo con URL stabili (M9, finestre multiple). Ogni finestra e' un normale client
 * WebSocket autenticato: nessuna comunicazione diretta fra finestre, il server e' l'unica fonte di verita'.
 *
 *   #/ ............................ tavolo completo (anche #/table)
 *   #/view/map ..................... solo la mappa (scena attiva o quella scelta)
 *   #/view/notes ................... schede e statblock
 *   #/view/chat .................... chat e dadi
 *   #/view/combat .................. tracker del combattimento
 *   #/view/scene/<id> .............. una scena precisa, anche non attiva (solo GM)
 *   #/view/player/<userId> ......... vista giocatore: la mappa come la riceve quel membro (solo GM)
 */

export type ViewRoute =
  | { kind: "table" }
  | { kind: "map" }
  | { kind: "notes" }
  | { kind: "chat" }
  | { kind: "combat" }
  | { kind: "scene"; sceneId: string }
  | { kind: "player"; userId: string };

export type SecondaryRoute = Exclude<ViewRoute, { kind: "table" }>;

/** Stessa forma degli id del protocollo (`IdSchema`): niente altro passa nell'URL. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Da percorso (senza `#`) a vista, o `null` se il percorso non e' una vista del tavolo. */
export function parseViewRoute(path: string): ViewRoute | null {
  if (path === "/" || path === "/table") return { kind: "table" };
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "view") return null;
  const [, kind, id, ...rest] = parts;
  if (rest.length > 0) return null;
  switch (kind) {
    case "map":
    case "notes":
    case "chat":
    case "combat":
      return id === undefined ? { kind } : null;
    case "scene":
      return id !== undefined && ID.test(id) ? { kind: "scene", sceneId: id } : null;
    case "player":
      return id !== undefined && ID.test(id) ? { kind: "player", userId: id } : null;
    default:
      return null;
  }
}

export function formatViewRoute(route: ViewRoute): string {
  switch (route.kind) {
    case "table":
      return "/table";
    case "scene":
      return `/view/scene/${route.sceneId}`;
    case "player":
      return `/view/player/${route.userId}`;
    default:
      return `/view/${route.kind}`;
  }
}

/** La vista richiede di essere GM (l'interfaccia la nasconde; il server verifica comunque). */
export function isGmOnly(route: ViewRoute): boolean {
  return route.kind === "scene" || route.kind === "player";
}

/** Nome della vista per titoli, menu e screen reader. */
export function viewTitle(route: ViewRoute, names: { scene?: string; player?: string } = {}): string {
  switch (route.kind) {
    case "table":
      return "Tavolo";
    case "map":
      return "Mappa";
    case "notes":
      return "Schede e note";
    case "chat":
      return "Chat";
    case "combat":
      return "Combattimento";
    case "scene":
      return names.scene ? `Scena: ${names.scene}` : "Scena";
    case "player":
      return names.player ? `Vista di ${names.player}` : "Vista giocatore";
  }
}
