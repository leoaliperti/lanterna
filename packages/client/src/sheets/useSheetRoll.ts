import { useCallback, useMemo } from "react";
import type { RollEntry, RollTarget, SheetDoc } from "@lanterna/shared";
import { MAX_ROLL_LABEL_LENGTH } from "@lanterna/shared";
import { useChatStore } from "../chat";
import { whisperTargets } from "../chat/commands";
import { useRoll } from "../chat/DiceBar";
import { useRealtimeState } from "../realtime/RealtimeProvider";
import { useToast } from "../ui";
import { formulaOf, rollTargetFor } from "./sheetLogic";
import { useSheets } from "./SheetsProvider";

const WAIT_MS = 10_000;

export interface SheetRoller {
  /** Tiro di scheda (abilita', salvezza, attacco, incantesimo...): formula e vantaggio dalla scheda, esito dal server. */
  rollTarget: (target: RollTarget, label: string) => Promise<void>;
  /** Una formula libera (danno di un attacco, dado vita...). */
  rollFormula: (formula: string, label: string) => Promise<boolean>;
  /** Come `rollTarget`, ma al ritorno dell'esito dal server chiama `then` (tiri contro la morte). */
  rollTargetThen: (target: RollTarget, label: string, then: (entry: RollEntry) => void) => Promise<void>;
  rollFormulaThen: (formula: string, label: string, then: (entry: RollEntry) => void) => Promise<void>;
}

/**
 * Tiri dalla scheda. Il client non calcola mai l'esito: invia `roll.request` con la formula di `rollFor`
 * (vantaggio/svantaggio gia' composti dalle condizioni) e il server risponde con `roll.result`.
 */
export function useSheetRoll(doc: SheetDoc): SheetRoller {
  const { user, isGm } = useSheets();
  const { view } = useRealtimeState();
  const store = useChatStore();
  const toast = useToast();
  const targets = useMemo(
    () => whisperTargets(view?.members ?? [], { userId: user.id, role: user.role }),
    [view, user.id, user.role]
  );
  const send = useRoll(isGm, targets);
  const who = doc.sheet.name.trim();

  const labelOf = useCallback(
    (label: string) => (who ? `${label} (${who})` : label).slice(0, MAX_ROLL_LABEL_LENGTH),
    [who]
  );

  const rollFormula = useCallback(
    async (formula: string, label: string) => {
      const problem = await send(formula, { label: labelOf(label), advantage: false });
      if (problem) {
        toast.show({ title: "Tiro non inviato", message: problem, tone: "warning" });
        return false;
      }
      return true;
    },
    [send, toast, labelOf]
  );

  const rollTarget = useCallback(
    async (target: RollTarget, label: string) => {
      const spec = rollTargetFor(doc, target);
      const formula = formulaOf(spec);
      if (formula === null) {
        toast.show({ title: label, message: "Fallimento automatico: non si tira.", tone: "warning" });
        return;
      }
      // Il vantaggio/svantaggio e' gia' nella formula: l'impostazione del pannello dei dadi non lo ripete.
      const problem = await send(formula, { label: labelOf(label), advantage: false });
      if (problem) toast.show({ title: "Tiro non inviato", message: problem, tone: "warning" });
    },
    [doc, send, toast, labelOf]
  );

  /** Resta in ascolto dell'esito (stesso autore e stessa etichetta) per un tempo limitato. */
  const waitFor = useCallback(
    (label: string, then: (entry: RollEntry) => void) => {
      const wanted = labelOf(label);
      let off: (() => void) | null = null;
      const timer = window.setTimeout(() => off?.(), WAIT_MS);
      off = store.onRoll((entry) => {
        if (entry.authorId !== user.id || entry.label !== wanted) return;
        window.clearTimeout(timer);
        off?.();
        then(entry);
      });
    },
    [store, user.id, labelOf]
  );

  const rollTargetThen = useCallback(
    async (target: RollTarget, label: string, then: (entry: RollEntry) => void) => {
      const spec = rollTargetFor(doc, target);
      if (spec.autoFail) {
        await rollTarget(target, label);
        return;
      }
      waitFor(label, then);
      await rollTarget(target, label);
    },
    [doc, rollTarget, waitFor]
  );

  const rollFormulaThen = useCallback(
    async (formula: string, label: string, then: (entry: RollEntry) => void) => {
      waitFor(label, then);
      await rollFormula(formula, label);
    },
    [rollFormula, waitFor]
  );

  return { rollTarget, rollFormula, rollTargetThen, rollFormulaThen };
}
