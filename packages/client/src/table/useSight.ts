import { useEffect, useMemo, useRef, useState } from "react";
import type { CampaignView, FogLighting, SceneView } from "@lanterna/shared";
import type { MapSight } from "../map";
import { SightEngine } from "../fog/sight";
import { blockingOf } from "../fog/wallLogic";
import { fogOfScene, toMapWalls } from "./adapter";

/**
 * Aiuto visivo "cosa vede il token": poligoni di visibilita' dei token con `vision` (il GM li vede tutti,
 * il giocatore solo i propri: gli altri hanno `vision: null`). NON modifica la nebbia.
 * Il ricalcolo e' selettivo (vedi `SightEngine`): si rifanno solo i token che si sono mossi o la cui vista
 * e' cambiata, o tutti se cambiano i muri; ogni passata ha un budget di pochi millisecondi e, se non basta,
 * continua al frame successivo.
 */
export function useSight(view: CampaignView, scene: SceneView | null, enabled: boolean): readonly MapSight[] | undefined {
  const engine = useRef<SightEngine | null>(null);
  if (!engine.current) engine.current = new SightEngine();
  const [areas, setAreas] = useState<readonly MapSight[] | undefined>(undefined);

  const tokens = useMemo(() => (scene ? view.tokens.filter((t) => t.sceneId === scene.id && t.vision) : []), [view.tokens, scene]);
  const segments = useMemo(() => (scene ? blockingOf(toMapWalls(view.walls, scene.id)) : []), [view.walls, scene]);
  const lighting: FogLighting = scene ? (fogOfScene(view, scene.id)?.lighting ?? "bright") : "bright";

  useEffect(() => {
    if (!enabled || !scene) {
      setAreas(undefined);
      return;
    }
    let raf = 0;
    let cancelled = false;
    const pass = () => {
      raf = 0;
      if (cancelled) return;
      const { areas: next, stats } = engine.current!.compute(scene, lighting, tokens, segments);
      setAreas((prev) => (sameAreas(prev, next) ? prev : next));
      // Budget esaurito: il resto al prossimo frame, senza bloccare l'interfaccia.
      if (stats.pending > 0 && typeof requestAnimationFrame === "function") raf = requestAnimationFrame(pass);
    };
    pass();
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [enabled, scene, lighting, tokens, segments]);

  return enabled ? areas : undefined;
}

const sameAreas = (a: readonly MapSight[] | undefined, b: readonly MapSight[]): boolean =>
  !!a && a.length === b.length && a.every((x, i) => x === b[i]);
