import { useCallback, useState, type FormEvent } from "react";
import { ChevronDown, Dices } from "lucide-react";
import type { EntryVisibility, Member } from "@lanterna/shared";
import { commandErrorToast } from "../realtime/errors";
import { Button, SegmentedControl, TextField, useToast } from "../ui";
import { useChat, useChatStore } from "./ChatProvider";
import type { AdvantageMode } from "./ChatStore";
import { RecipientSelect } from "./RecipientSelect";

const QUICK_DICE = [4, 6, 8, 10, 12, 20, 100] as const;

const VISIBILITY_NOTE: Record<EntryVisibility, string> = {
  public: "Tutti vedono il tiro",
  whisper: "Solo tu e il destinatario",
  gm: "Solo il GM vede il tiro"
};

/**
 * Invia una richiesta di tiro al server con le impostazioni del pannello dei dadi.
 * Ritorna un messaggio da mostrare nel campo (formula non valida, destinatario mancante) oppure `null`.
 * Il client non calcola mai l'esito: arriva come `roll.result`.
 */
export function useRoll(isGm: boolean, targets: readonly Member[]) {
  const store = useChatStore();
  const toast = useToast();
  return useCallback(
    async (formula: string, opts: { label?: string; advantage?: boolean } = {}): Promise<string | null> => {
      const c = store.getState().composer;
      let f = formula.trim();
      if (!f) return "Scrivi una formula, per esempio 2d6+3.";
      if (opts.advantage !== false && c.advantage !== "normal" && !/(^|\s)(adv|dis)(\s|$)/i.test(f)) {
        f += c.advantage === "advantage" ? " adv" : " dis";
      }
      let visibility = c.visibility;
      if (!isGm && visibility === "gm") visibility = "public";
      let whisperTo: string | undefined;
      if (visibility === "whisper") {
        const wanted = c.recipient ?? (isGm ? null : (targets[0]?.userId ?? null));
        if (!wanted || !targets.some((t) => t.userId === wanted)) {
          return isGm ? "Scegli a chi sussurrare il tiro." : "Non c'è nessun GM a cui sussurrare.";
        }
        whisperTo = wanted;
      }
      const label = (opts.label ?? c.label).trim();
      const r = await store.sendRoll({ formula: f, visibility, ...(whisperTo ? { whisperTo } : {}), ...(label ? { label } : {}) });
      if (r.ok) return null;
      // Formula non valida: il messaggio del parser (italiano) va accanto al campo.
      if (r.code === "INVALID" && r.reason) return r.message.charAt(0).toUpperCase() + r.message.slice(1);
      toast.show(commandErrorToast(r));
      return null;
    },
    [store, toast, isGm, targets]
  );
}

export interface DiceBarProps {
  isGm: boolean;
  targets: readonly Member[];
}

/** Barra rapida dei dadi, formula libera e opzioni del tiro (visibilita', vantaggio, etichetta). */
export function DiceBar({ isGm, targets }: DiceBarProps) {
  const store = useChatStore();
  const { composer } = useChat();
  const roll = useRoll(isGm, targets);
  const [open, setOpen] = useState(composer.visibility !== "public" || composer.advantage !== "normal" || composer.label !== "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (formula: string, opts?: { advantage?: boolean }) => {
      setBusy(true);
      setError(null);
      const message = await roll(formula, opts);
      setBusy(false);
      setError(message);
      return message === null;
    },
    [roll]
  );

  async function submitFormula(e: FormEvent) {
    e.preventDefault();
    if (await run(composer.formula)) store.patchComposer({ formula: "" });
  }

  const visibilityOptions: Array<{ value: EntryVisibility; label: string }> = [
    { value: "public", label: "Pubblico" },
    { value: "whisper", label: "Sussurro" },
    ...(isGm ? [{ value: "gm" as const, label: "Solo GM" }] : [])
  ];
  const effective: EntryVisibility = !isGm && composer.visibility === "gm" ? "public" : composer.visibility;

  return (
    <section className="a-dice" aria-label="Dadi">
      <div className="a-dice__quick" role="group" aria-label="Tira un dado">
        {QUICK_DICE.map((s) => (
          <button
            key={s}
            type="button"
            className="a-dice__die"
            aria-label={`Tira un d${s}${s === 20 && composer.advantage !== "normal" ? (composer.advantage === "advantage" ? " con vantaggio" : " con svantaggio") : ""}`}
            onClick={() => void run(`1d${s}`, { advantage: s === 20 })}
          >
            {s === 100 ? "d%" : `d${s}`}
          </button>
        ))}
        <button
          type="button"
          className="a-dice__more"
          aria-expanded={open}
          aria-controls="a-dice-options"
          aria-label="Opzioni del tiro"
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDown size={18} aria-hidden="true" data-open={open} />
        </button>
      </div>

      {effective !== "public" || composer.advantage !== "normal" ? (
        <p className="a-dice__note t-caption1">
          {effective !== "public" ? VISIBILITY_NOTE[effective] : null}
          {effective !== "public" && composer.advantage !== "normal" ? " · " : null}
          {composer.advantage === "advantage" ? "Vantaggio sul d20" : composer.advantage === "disadvantage" ? "Svantaggio sul d20" : null}
        </p>
      ) : null}

      {open ? (
        <div id="a-dice-options" className="a-dice__options a-enter">
          <SegmentedControl<AdvantageMode>
            aria-label="Vantaggio o svantaggio"
            value={composer.advantage}
            onValueChange={(advantage) => store.patchComposer({ advantage })}
            options={[
              { value: "normal", label: "Normale" },
              { value: "advantage", label: "Vantaggio" },
              { value: "disadvantage", label: "Svantaggio" }
            ]}
          />
          <SegmentedControl<EntryVisibility>
            aria-label="Chi vede il tiro"
            value={effective}
            onValueChange={(visibility) => store.patchComposer({ visibility })}
            options={visibilityOptions}
          />
          {effective === "whisper" && (isGm || targets.length > 1) ? (
            <RecipientSelect
              targets={targets}
              value={composer.recipient}
              allLabel={isGm ? "Scegli..." : targets[0] ? `${targets[0].displayName} (GM)` : "Scegli..."}
              label="Sussurra il tiro a"
              onChange={(recipient) => store.patchComposer({ recipient })}
            />
          ) : null}
          <TextField
            label="Etichetta del tiro"
            placeholder="Etichetta (facoltativa)"
            value={composer.label}
            maxLength={100}
            autoComplete="off"
            onChange={(e) => store.patchComposer({ label: e.target.value })}
          />
        </div>
      ) : null}

      <form className="a-dice__formula" onSubmit={(e) => void submitFormula(e)} noValidate>
        <TextField
          label="Formula"
          hideLabel
          placeholder="Formula: 2d6+3, 4d6kh3, d20 adv"
          value={composer.formula}
          maxLength={200}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          inputMode="text"
          error={error ?? undefined}
          onChange={(e) => {
            setError(null);
            store.patchComposer({ formula: e.target.value });
          }}
        />
        <Button type="submit" variant="tinted" icon={<Dices size={16} />} loading={busy}>
          Tira
        </Button>
      </form>
    </section>
  );
}
