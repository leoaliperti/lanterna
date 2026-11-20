import type { ServerEvent } from "../state/filter.js";
import type { CampaignView, TokenView } from "../state/view.js";
import type { DeltaMessage } from "./messages.js";

/**
 * Lato client: applica gli eventi ricevuti alla vista locale. Logica pura,
 * usata dal client e dai test (che verificano che applicare i delta dia
 * esattamente `viewFor` sul server).
 */
export function applyServerEvent(view: CampaignView, event: ServerEvent): CampaignView {
  switch (event.type) {
    case "token.created":
      if (view.tokens.some((t) => t.id === event.token.id)) return view;
      return { ...view, tokens: [...view.tokens, event.token] };
    case "token.updated":
      return {
        ...view,
        tokens: view.tokens.map((t) => (t.id === event.tokenId ? ({ ...t, ...event.changes } as TokenView) : t)),
      };
    case "token.deleted":
      return { ...view, tokens: view.tokens.filter((t) => t.id !== event.tokenId) };
    case "scene.created":
      if (view.scenes.some((s) => s.id === event.scene.id)) return view;
      return { ...view, scenes: [...view.scenes, event.scene] };
    case "scene.updated":
      return {
        ...view,
        scenes: view.scenes.map((s) => (s.id === event.sceneId ? { ...s, ...event.changes } : s)),
      };
    case "scene.deleted":
      return { ...view, scenes: view.scenes.filter((s) => s.id !== event.sceneId) };
    case "scene.activated": {
      if (view.viewer.role === "admin") {
        // Il GM ha già tutto: cambia solo la scena attiva.
        return { ...view, activeSceneId: event.sceneId };
      }
      // Il giocatore vede solo la scena attiva: sostituisce scena, token, nebbia e muri.
      return {
        ...view,
        activeSceneId: event.sceneId,
        scenes: event.scene ? [event.scene] : [],
        tokens: event.tokens,
        fogs: event.fog ? [event.fog] : [],
        walls: event.walls ?? [],
        props: event.props ?? [],
      };
    }
    case "fog.updated": {
      const others = (view.fogs ?? []).filter((f) => f.sceneId !== event.sceneId);
      return { ...view, fogs: event.fog ? [...others, event.fog] : others };
    }
    case "wall.created":
      if ((view.walls ?? []).some((w) => w.id === event.wall.id)) return view;
      return { ...view, walls: [...(view.walls ?? []), event.wall] };
    case "wall.updated":
      return { ...view, walls: (view.walls ?? []).map((w) => (w.id === event.wall.id ? event.wall : w)) };
    case "wall.deleted":
      return { ...view, walls: (view.walls ?? []).filter((w) => w.id !== event.wallId) };
    case "prop.created":
      if ((view.props ?? []).some((p) => p.id === event.prop.id)) return view;
      return { ...view, props: [...(view.props ?? []), event.prop] };
    case "prop.updated":
      return { ...view, props: (view.props ?? []).map((p) => (p.id === event.prop.id ? event.prop : p)) };
    case "prop.deleted":
      return { ...view, props: (view.props ?? []).filter((p) => p.id !== event.propId) };
    case "combat.updated": {
      const others = (view.combats ?? []).filter((c) => c.sceneId !== event.sceneId);
      return { ...view, combats: event.combat ? [...others, event.combat] : others };
    }
    case "group.created":
      if ((view.groups ?? []).some((g) => g.id === event.group.id)) return view;
      return { ...view, groups: [...(view.groups ?? []), event.group] };
    case "group.updated":
      return { ...view, groups: (view.groups ?? []).map((g) => (g.id === event.group.id ? event.group : g)) };
    case "group.deleted":
      return { ...view, groups: (view.groups ?? []).filter((g) => g.id !== event.groupId) };
    // Avvisi: non cambiano la vista (il client li mostra a modo suo).
    case "combat.turn":
    case "effect.expiring":
    case "effect.expired":
      return view;
  }
}

export type DeltaOutcome = { ok: true; view: CampaignView } | { ok: false; reason: "gap" | "epoch" };

/**
 * Applica un messaggio `delta`. Se non segue la versione locale (buco) o
 * l'epoca è cambiata, il client deve inviare un nuovo `hello`.
 */
export function applyDelta(view: CampaignView, epoch: string, delta: DeltaMessage): DeltaOutcome {
  if (delta.epoch !== epoch) return { ok: false, reason: "epoch" };
  if (delta.fromVersion !== view.version) return { ok: false, reason: "gap" };
  const next = delta.events.reduce(applyServerEvent, view);
  return { ok: true, view: { ...next, version: delta.toVersion } };
}
