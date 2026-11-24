import { useEffect, useRef, useState } from "react";
import type { CampaignView } from "@lanterna/shared";
import { Button, Picker, SegmentedControl, Sheet, TextField, Toggle, useToast } from "../ui";
import { useCommands } from "../realtime/RealtimeProvider";
import { CONDITION_LIST } from "../table/conditions";
import { emptyEffectDraft, hasEffectErrors, validateEffectDraft } from "./effectsLogic";
import { ACTION_LABELS, applyCommand, describeAction, groupAction, type ActionDraft, type ActionKind } from "./selectionLogic";
import "./combat.css";

export interface ActionRequest {
  kind: ActionKind;
  tokenIds: readonly string[];
}

export interface ActionSheetProps {
  view: CampaignView;
  /** Celle della griglia della scena mostrata (serve a convertire "sposta di N celle" in pixel). */
  cellSize: number;
  request: ActionRequest | null;
  onClose: () => void;
}

function initialDraft(kind: ActionKind): ActionDraft {
  return {
    kind,
    amount: "",
    critical: false,
    conditionId: "",
    removeCondition: false,
    effect: emptyEffectDraft(),
    dx: "0",
    dy: "0"
  };
}

const NO_CONDITION = "__none__";

/**
 * Azione rapida su uno o piu' token (danno, cura, PF temporanei, condizione, effetto, spostamento). Invia un solo
 * `group.apply`: il server la applica a tutti o a nessuno e si annulla in un colpo con "Annulla".
 */
export function ActionSheet({ view, cellSize, request, onClose }: ActionSheetProps) {
  const { run, undo } = useCommands();
  const toast = useToast();
  const [draft, setDraft] = useState<ActionDraft>(() => initialDraft(request?.kind ?? "damage"));
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = request !== null;
  // Il focus parte dal primo campo (non dal pulsante "Fine"): si puo' scrivere subito il numero.
  const firstField = useRef<HTMLInputElement>(null);
  const kind = request?.kind ?? draft.kind;

  // Si riparte da una bozza pulita a ogni apertura.
  useEffect(() => {
    if (request) {
      setDraft(initialDraft(request.kind));
      setSubmitted(false);
      setBusy(false);
    }
  }, [request]);

  const count = request?.tokenIds.length ?? 0;
  const set = <K extends keyof ActionDraft>(key: K, value: ActionDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const effectErrors = validateEffectDraft(draft.effect);
  const firstScene = view.tokens.find((t) => t.id === request?.tokenIds[0])?.sceneId;
  const sceneTokens = view.tokens.filter((t) => t.sceneId === firstScene);

  async function submit() {
    setSubmitted(true);
    if (!request) return;
    if (kind === "effect" && hasEffectErrors(effectErrors)) return;
    const action = groupAction({ ...draft, kind }, crypto.randomUUID(), cellSize);
    if (!action) return;
    setBusy(true);
    try {
      if (await run(applyCommand(request.tokenIds, action))) {
        toast.show({ title: describeAction({ ...draft, kind }, count), tone: "success", duration: 5000, action: { label: "Annulla", onPress: () => void undo() } });
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  const amountError = submitted && (kind === "damage" || kind === "heal" || kind === "tempHp") && !groupAction({ ...draft, kind }, "x", cellSize) ? "Un numero intero, da 0 in su." : undefined;
  const moveError = submitted && kind === "move" && !groupAction({ ...draft, kind }, "x", cellSize) ? "Indica di quante celle spostare (non entrambe zero)." : undefined;
  const conditionError = submitted && kind === "condition" && !draft.conditionId ? "Scegli una condizione." : undefined;
  const title = `${ACTION_LABELS[kind]}: ${count === 1 ? "1 token" : `${count} token`}`;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()} title={title} initialFocus={firstField}>
      <form
        className="c-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {kind === "damage" || kind === "heal" || kind === "tempHp" ? (
          <TextField
            ref={firstField}
            label={kind === "damage" ? "Danni" : kind === "heal" ? "Punti ferita da curare" : "Punti ferita temporanei"}
            inputMode="numeric"
            value={draft.amount}
            onChange={(e) => set("amount", e.target.value)}
            error={amountError}
            autoComplete="off"
          />
        ) : null}
        {kind === "damage" ? <Toggle label="Colpo critico" checked={draft.critical} onCheckedChange={(v) => set("critical", v)} /> : null}
        {kind === "damage" ? <p className="t-caption1 a-muted c-hint">Il danno scala prima i PF temporanei. Chi non ha la barra della vita non cambia.</p> : null}

        {kind === "condition" ? (
          <>
            <SegmentedControl
              aria-label="Aggiungere o togliere"
              value={draft.removeCondition ? "remove" : "add"}
              onValueChange={(v) => set("removeCondition", v === "remove")}
              options={[
                { value: "add", label: "Aggiungi" },
                { value: "remove", label: "Togli" }
              ]}
            />
            <ConditionPicker value={draft.conditionId} onChange={(v) => set("conditionId", v)} error={conditionError} />
          </>
        ) : null}

        {kind === "effect" ? (
          <>
            <TextField
              ref={firstField}
              label="Nome dell'effetto"
              value={draft.effect.name}
              onChange={(e) => set("effect", { ...draft.effect, name: e.target.value })}
              error={submitted ? (effectErrors.name ?? undefined) : undefined}
              autoComplete="off"
            />
            <div className="a-field-group">
              <span className="t-footnote a-muted">Condizione collegata</span>
              <Picker
                label="Condizione collegata"
                options={[{ value: NO_CONDITION, label: "Nessuna" }, ...CONDITION_LIST.map((c) => ({ value: c.id as string, label: c.name }))]}
                value={draft.effect.conditionId ?? NO_CONDITION}
                onValueChange={(v) => set("effect", { ...draft.effect, conditionId: v === NO_CONDITION ? null : v })}
              />
              <p className="t-caption1 a-muted">La condizione si aggiunge ai token e si toglie alla scadenza.</p>
            </div>
            <TextField
              label="Durata in round"
              inputMode="numeric"
              value={draft.effect.duration}
              onChange={(e) => set("effect", { ...draft.effect, duration: e.target.value })}
              error={submitted ? (effectErrors.duration ?? undefined) : undefined}
              helper="Vuoto = senza scadenza. Un round è un turno di chi ha lanciato l'effetto."
              autoComplete="off"
            />
            <div className="a-field-group">
              <span className="t-footnote a-muted">Scade</span>
              <SegmentedControl
                aria-label="Momento della scadenza"
                value={draft.effect.timing}
                onValueChange={(v) => set("effect", { ...draft.effect, timing: v })}
                options={[
                  { value: "start", label: "A inizio turno" },
                  { value: "end", label: "A fine turno" }
                ]}
              />
            </div>
            <div className="a-field-group">
              <span className="t-footnote a-muted">Conta il turno di</span>
              <Picker
                label="Conta il turno di"
                options={[{ value: NO_CONDITION, label: "Il token stesso" }, ...sceneTokens.map((t) => ({ value: t.id, label: t.name }))]}
                value={draft.effect.anchorTokenId ?? NO_CONDITION}
                onValueChange={(v) => set("effect", { ...draft.effect, anchorTokenId: v === NO_CONDITION ? null : v })}
              />
            </div>
            <Toggle label="Segreto (lo vede solo il GM)" checked={draft.effect.secret} onCheckedChange={(v) => set("effect", { ...draft.effect, secret: v })} />
          </>
        ) : null}

        {kind === "move" ? (
          <>
            <div className="a-form__pair">
              <TextField ref={firstField} label="Celle a destra (negativo = sinistra)" inputMode="decimal" value={draft.dx} onChange={(e) => set("dx", e.target.value)} autoComplete="off" />
              <TextField label="Celle in basso (negativo = in alto)" inputMode="decimal" value={draft.dy} onChange={(e) => set("dy", e.target.value)} autoComplete="off" />
            </div>
            {moveError ? (
              <p className="t-footnote a-picker__error" role="alert">
                {moveError}
              </p>
            ) : null}
            <p className="t-caption1 a-muted c-hint">Lo spostamento non si aggancia alla griglia: si muovono tutti dello stesso scarto.</p>
          </>
        ) : null}

        <div className="c-form__actions">
          <Button variant="gray" onClick={onClose} disabled={busy}>
            Annulla
          </Button>
          <Button type="submit" loading={busy}>
            Applica
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

function ConditionPicker({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string }) {
  return (
    <div className="a-field-group">
      <span className="t-footnote a-muted">Condizione</span>
      <Picker
        label="Condizione"
        options={[{ value: NO_CONDITION, label: "Scegli..." }, ...CONDITION_LIST.map((c) => ({ value: c.id as string, label: c.name }))]}
        value={value || NO_CONDITION}
        onValueChange={(v) => onChange(v === NO_CONDITION ? "" : v)}
      />
      {error ? (
        <p className="t-footnote a-picker__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
