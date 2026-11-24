import { useEffect, useRef, useState } from "react";
import type { RollEntry } from "@lanterna/shared";
import { DiceTray, type DiceTrayHandle } from "../dice3d";
import { isWebGLAvailable, prefersReducedMotion } from "../dice3d/webgl";
import { useSettings } from "../settings/settings";
import { useChatStore } from "./ChatProvider";
import "./chat.css";

const SUPPORTED = new Set([4, 6, 8, 10, 12, 20, 100]);
/** Oltre questo numero di dadi l'animazione sarebbe solo confusione: il testo in chat basta. */
export const MAX_ANIMATED_DICE = 20;
const SHOW_MS = 3600;
const FADE_MS = 300;

type Die = { sides: 4 | 6 | 8 | 10 | 12 | 20 | 100; value: number };

/**
 * Dadi da animare per un tiro: SOLO i valori decisi dal server (`terms[].dice`), compresi quelli
 * scartati dal "keep". Dadi che il tavolo 3D non sa disegnare (d3, d1000...) si saltano.
 */
export function diceFromRoll(entry: RollEntry): Die[] {
  const out: Die[] = [];
  for (const term of entry.terms) {
    if (term.kind !== "dice") continue;
    for (const d of term.dice) if (SUPPORTED.has(d.face)) out.push({ sides: d.face as Die["sides"], value: d.value });
  }
  return out.length > MAX_ANIMATED_DICE ? [] : out;
}

/**
 * Overlay non invasivo sopra la mappa: mostra i dadi di ogni tiro ricevuto dal server (solo quelli
 * che l'utente puo' vedere: il server non manda gli altri), poi scompare da solo. Non intercetta
 * il puntatore. Non compare con l'animazione disattivata, con movimento ridotto o senza WebGL:
 * il risultato resta in chat.
 */
export function DiceOverlay() {
  const store = useChatStore();
  const { dice3d } = useSettings();
  const [webgl] = useState(() => isWebGLAvailable());
  const [anim, setAnim] = useState<{ key: string; dice: Die[]; leaving: boolean } | null>(null);
  const tray = useRef<DiceTrayHandle>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = () => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  };

  useEffect(() => clearTimers, []);

  useEffect(() => {
    if (!dice3d || !webgl) return;
    return store.onRoll((entry) => {
      if (prefersReducedMotion()) return;
      const dice = diceFromRoll(entry);
      if (dice.length === 0) return;
      clearTimers();
      setAnim({ key: entry.id, dice, leaving: false });
    });
  }, [store, dice3d, webgl]);

  // Il tiro parte quando il tavolo e' montato; a fine animazione l'overlay resta qualche secondo e svanisce.
  const key = anim?.key;
  useEffect(() => {
    if (!anim) return;
    void tray.current?.roll(anim.dice).catch(() => setAnim(null));
    // Parte una volta per tiro (cambia `key`), non a ogni render.
  }, [key]);

  // Spegnere l'animazione dalle impostazioni la toglie subito.
  useEffect(() => {
    if (!dice3d) {
      clearTimers();
      setAnim(null);
    }
  }, [dice3d]);

  if (!anim) return null;
  const onSettled = () => {
    clearTimers();
    timers.current.push(
      setTimeout(() => setAnim((a) => (a ? { ...a, leaving: true } : a)), SHOW_MS),
      setTimeout(() => setAnim(null), SHOW_MS + FADE_MS)
    );
  };
  return (
    <div className="a-dice-overlay" data-leaving={anim.leaving || undefined} aria-hidden="true">
      <DiceTray ref={tray} onSettled={onSettled} />
    </div>
  );
}
