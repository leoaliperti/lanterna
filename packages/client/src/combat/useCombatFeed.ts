import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { defaultTtlMs, type CampaignView, type EphemeralAudience, type Shape } from "@lanterna/shared";
import type { MapCanvasHandle, MapEphemeral, MapPulse, ShapePhase } from "../map";
import { commandErrorToast } from "../realtime/errors";
import { useRealtimeClient } from "../realtime/RealtimeProvider";
import { useToast } from "../ui";
import { AlertDeduper, alertKey, presentAlert } from "./alerts";
import { EphemeralStore, isShapeMessage, shapesOfScene } from "./ephemeralStore";

/** Quanto resta visibile il richiamo sul token (il disegno dura meno: serve a non perderlo se la scheda era in secondo piano). */
const PULSE_LIFETIME_MS = 2500;
/** Pausa minima fra due invii durante il trascinamento (il server accetta ~10 al secondo). */
const DRAFT_INTERVAL_MS = 120;

export interface CombatFeed {
  /** Forme effimere vive sulla scena mostrata (ricevute e create qui). */
  shapes: MapEphemeral[];
  pulses: MapPulse[];
  audience: EphemeralAudience;
  setAudience: (a: EphemeralAudience) => void;
  onShape: (shape: Shape, phase: ShapePhase) => void;
  onShapeCancel: () => void;
}

interface FeedOptions {
  view: CampaignView;
  /** Scena mostrata (quella su cui si disegna). */
  sceneId: string | null;
  mapRef: RefObject<MapCanvasHandle | null>;
}

const newId = () => crypto.randomUUID();

/**
 * Collega la mappa al combattimento in tempo reale: forme effimere in arrivo, avvisi (toast leggero e richiamo
 * sul token, senza doppioni) e invio delle misure pubbliche. Le misure PRIVATE non partono mai dal client.
 */
export function useCombatFeed({ view, sceneId, mapRef }: FeedOptions): CombatFeed {
  const client = useRealtimeClient();
  const toast = useToast();
  const self = view.viewer.userId;
  const store = useMemo(() => new EphemeralStore(), []);
  const deduper = useMemo(() => new AlertDeduper(), []);
  const shapes = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [pulses, setPulses] = useState<MapPulse[]>([]);
  const [audience, setAudience] = useState<EphemeralAudience>("private");
  const audienceRef = useRef(audience);
  audienceRef.current = audience;
  const viewRef = useRef(view);
  viewRef.current = view;
  const sceneRef = useRef(sceneId);
  sceneRef.current = sceneId;
  const current = useRef<{ id: string | null; last: number }>({ id: null, last: 0 });

  useEffect(() => () => store.dispose(), [store]);

  // Un cambio di scena toglie le misure in corso (e quelle ancora vive: appartenevano alla scena di prima).
  useEffect(() => {
    current.current = { id: null, last: 0 };
  }, [sceneId]);

  useEffect(
    () =>
      client.onEvent((e) => {
        if (e.type === "message" && isShapeMessage(e.message)) {
          store.receive(e.message);
          return;
        }
        if (e.type !== "alert") return;
        if (!deduper.accept(e.alert)) return;
        const alert = e.alert;
        const v = viewRef.current;
        const participant = alert.type === "combat.turn" ? v.combats?.find((c) => c.sceneId === alert.sceneId)?.participants.find((p) => p.id === alert.participantId) : undefined;
        const shown = presentAlert(alert, v.tokens, participant?.name);
        toast.show(shown.toast);
        const pulse = shown.pulse;
        if (pulse) {
          const key = `${alertKey(alert)}|${Date.now()}`;
          setPulses((list) => [...list, { key, ...pulse }]);
          setTimeout(() => setPulses((list) => list.filter((p) => p.key !== key)), PULSE_LIFETIME_MS);
        }
      }),
    [client, store, deduper, toast]
  );

  const onShape = useCallback(
    (shape: Shape, phase: ShapePhase) => {
      const scene = sceneRef.current;
      if (!scene) return;
      const aud = audienceRef.current;
      const transient = shape.kind === "ping" || shape.kind === "arrow";
      if (aud === "private") {
        // Misura privata: niente al server. Frecce e ping non hanno una "bozza": si vedono qui per qualche secondo.
        if (phase === "end" && transient) store.add({ id: newId(), authorId: self, sceneId: scene, shape, ttlMs: defaultTtlMs(shape) });
        return;
      }
      const state = current.current;
      if (phase === "draft") {
        const now = Date.now();
        if (now - state.last < DRAFT_INTERVAL_MS) return;
        state.last = now;
        state.id ??= newId();
        void client.showEphemeral({ id: state.id, sceneId: scene, audience: aud, shape });
        return;
      }
      const id = state.id ?? newId();
      state.id = null;
      const ttlMs = defaultTtlMs(shape);
      // L'autore non riceve la propria forma dal server: la tiene qui, con la stessa scadenza degli altri.
      store.add({ id, authorId: self, sceneId: scene, shape, ttlMs });
      mapRef.current?.clearMeasure();
      void client.showEphemeral({ id, sceneId: scene, audience: aud, shape, ttlMs }).then((r) => {
        if (!r.ok) {
          store.remove(self, id);
          toast.show(commandErrorToast(r));
        }
      });
    },
    [client, store, self, mapRef, toast]
  );

  const onShapeCancel = useCallback(() => {
    const id = current.current.id;
    current.current.id = null;
    if (id) void client.clearEphemeral(id);
  }, [client]);

  const live = useMemo(() => shapesOfScene(shapes, sceneId), [shapes, sceneId]);
  return { shapes: live, pulses, audience, setAudience, onShape, onShapeCancel };
}
