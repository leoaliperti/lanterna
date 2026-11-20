import { AppWindow, Eye, Layers, Map as MapIcon, MessageSquare, ScrollText, Swords } from "lucide-react";
import type { CampaignView } from "@lanterna/shared";
import type { SessionUser } from "../api/client";
import { IconButton, Menu, useToast, type MenuItemSpec, type ToastInput } from "../ui";
import { openViewWindow } from "./layout";
import type { SecondaryRoute } from "./routes";

export const POPUP_BLOCKED: ToastInput = {
  title: "Finestra bloccata dal browser",
  message: "Consenti le finestre popup per Lanterna e riprova.",
  tone: "warning",
  duration: 6000
};

/** Voci del menu "Finestre": viste per tutti, poi (solo GM) scene e viste giocatore. */
export function windowItems(user: Pick<SessionUser, "id" | "role">, view: CampaignView | null): { route: SecondaryRoute; label: string; group: "view" | "scene" | "player" }[] {
  const items: { route: SecondaryRoute; label: string; group: "view" | "scene" | "player" }[] = [
    { route: { kind: "map" }, label: "Mappa", group: "view" },
    { route: { kind: "notes" }, label: "Schede e note", group: "view" },
    { route: { kind: "chat" }, label: "Chat", group: "view" },
    { route: { kind: "combat" }, label: "Combattimento", group: "view" }
  ];
  if (user.role !== "admin" || !view) return items;
  for (const s of view.scenes) {
    items.push({ route: { kind: "scene", sceneId: s.id }, label: `Scena: ${s.name}${s.id === view.activeSceneId ? " (in gioco)" : ""}`, group: "scene" });
  }
  for (const m of view.members) {
    if (m.role === "player") items.push({ route: { kind: "player", userId: m.userId }, label: `Vista di ${m.displayName}`, group: "player" });
  }
  return items;
}

const ICONS = {
  map: <MapIcon size={18} />,
  notes: <ScrollText size={18} />,
  chat: <MessageSquare size={18} />,
  combat: <Swords size={18} />,
  scene: <Layers size={18} />,
  player: <Eye size={18} />
} as const;

/**
 * Menu "Finestre" nella barra del tavolo (M9): apre ogni vista in una finestra a parte, anche da
 * spostare su un altro schermo. Ogni finestra e' un client WebSocket indipendente.
 */
export function WindowsMenu({ user, view }: { user: SessionUser; view: CampaignView | null }) {
  const toast = useToast();
  const items: MenuItemSpec[] = windowItems(user, view).map(({ route, label }) => ({
    id: `${route.kind}-${"sceneId" in route ? route.sceneId : "userId" in route ? route.userId : ""}`,
    label,
    icon: ICONS[route.kind],
    onSelect: () => {
      if (!openViewWindow(route)) toast.show(POPUP_BLOCKED);
    }
  }));
  return (
    <Menu
      label="Apri in nuova finestra"
      placement="bottom-end"
      items={items}
      trigger={<IconButton label="Apri in nuova finestra" icon={<AppWindow size={20} />} />}
    />
  );
}
