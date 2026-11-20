import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronLeft, ChevronRight, Dices, Eye, EyeOff, GripVertical, MoreHorizontal, Play, Plus, Square, Swords, UserPlus } from "lucide-react";
import type { CampaignView, CombatView, InitiativeMode, ParticipantView, SceneView } from "@lanterna/shared";
import { Alert, Badge, Button, IconButton, Menu, SegmentedControl, TextField, Toggle, useToast, type MenuItemSpec } from "../ui";
import { commandErrorToast } from "../realtime/errors";
import { useCommands, useRealtimeClient } from "../realtime/RealtimeProvider";
import {
  addEntryCommand,
  addTokenCommand,
  clearInitiativeCommand,
  combatOf,
  dropIndex,
  formatInitiative,
  movedIndex,
  parseBonus,
  parseInitiative,
  previewOrder,
  reorderCommand,
  rollRequest,
  setInitiativeCommand,
  statusLine,
  tokensToAdd,
  withoutInitiative
} from "./combatLogic";
import "./combat.css";

export interface InitiativePanelProps {
  view: CampaignView;
  scene: SceneView | null;
  /** Token selezionati sulla mappa (si possono aggiungere al combattimento con un clic). */
  selected: readonly string[];
}

/**
 * Tracker dell'iniziativa. Il giocatore vede solo cio' che il server gli ha inviato (niente voci nascoste, niente
 * valori nascosti); il GM ha tutti i comandi. L'esito del tiro lo decide il server (`initiative.roll`).
 */
export function InitiativePanel({ view, scene, selected }: InitiativePanelProps) {
  const isGm = view.viewer.role === "admin";
  const { run } = useCommands();
  const client = useRealtimeClient();
  const toast = useToast();
  const sceneId = scene?.id ?? null;
  const combat = combatOf(view, sceneId);
  const [bonus, setBonus] = useState("0");
  const [mode, setMode] = useState<InitiativeMode>("normal");
  const [sortAfter, setSortAfter] = useState(true);
  const [entryName, setEntryName] = useState("");
  const [entryInit, setEntryInit] = useState("");
  const [entryHidden, setEntryHidden] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);

  if (!scene || !sceneId) {
    return (
      <div className="c-tracker">
        <p className="t-subhead a-muted c-tracker__empty">Non c&apos;è una scena da mostrare.</p>
      </div>
    );
  }

  const sceneTokens = view.tokens.filter((t) => t.sceneId === sceneId);
  const addable = tokensToAdd(sceneTokens, sceneId, combat);
  const selectedAddable = addable.filter((t) => selected.includes(t.id));
  const missing = withoutInitiative(combat);
  const started = combat?.started ?? false;
  const count = combat?.participants.length ?? 0;
  const bonusValue = parseBonus(bonus);

  async function roll(ids: readonly string[]) {
    if (bonusValue === "invalid") {
      toast.show({ title: "Bonus non valido", message: "Un numero intero da -50 a 50.", tone: "warning" });
      return;
    }
    const request = rollRequest(sceneId!, ids, { bonus: bonusValue, mode }, sortAfter);
    if (!request) return;
    const r = await client.rollInitiative(request);
    if (!r.ok) toast.show(commandErrorToast(r));
  }

  async function addTokens(ids: readonly string[]) {
    for (const tokenId of ids) {
      if (!(await run(addTokenCommand(crypto.randomUUID(), sceneId!, tokenId)))) return;
    }
  }

  async function addEntry() {
    const init = parseInitiative(entryInit);
    if (init === "invalid") {
      toast.show({ title: "Iniziativa non valida", message: "Un numero, oppure vuoto.", tone: "warning" });
      return;
    }
    const cmd = addEntryCommand(crypto.randomUUID(), sceneId!, entryName, init, entryHidden);
    if (!cmd) {
      toast.show({ title: "Serve un nome", message: "Scrivi il nome della voce (una trappola, un evento).", tone: "warning" });
      return;
    }
    if (await run(cmd)) {
      setEntryName("");
      setEntryInit("");
    }
  }

  const addMenu: MenuItemSpec[] = addable.slice(0, 30).map((t) => ({ id: t.id, label: t.name, onSelect: () => void addTokens([t.id]) }));

  return (
    <div className="c-tracker">
      <p className="c-tracker__status t-subhead" role="status" aria-live="polite">
        {started ? <Badge tone="tint">Round {combat!.round}</Badge> : null}
        <strong>{statusLine(combat)}</strong>
      </p>

      {isGm ? (
        <>
          <div className="c-tracker__bar" role="group" aria-label="Turni">
            {!started ? (
              <Button size="sm" icon={<Play size={16} />} disabled={count === 0} onClick={() => void run({ type: "combat.start", sceneId, sort: sortAfter })}>
                Avvia
              </Button>
            ) : (
              <>
                <Button size="sm" variant="gray" icon={<ChevronLeft size={16} />} onClick={() => void run({ type: "combat.previous", sceneId })}>
                  Indietro
                </Button>
                <Button size="sm" icon={<ChevronRight size={16} />} onClick={() => void run({ type: "combat.next", sceneId })}>
                  Avanti
                </Button>
                <Button size="sm" variant="destructive" icon={<Square size={16} />} onClick={() => setConfirmEnd(true)}>
                  Termina
                </Button>
              </>
            )}
            <Button size="sm" variant="gray" disabled={count < 2} onClick={() => void run({ type: "combat.sort", sceneId })}>
              Ordina per iniziativa
            </Button>
          </div>

          <section className="c-tracker__section" aria-label="Aggiungere partecipanti">
            <div className="c-tracker__bar">
              <Button size="sm" variant="tinted" icon={<UserPlus size={16} />} disabled={selectedAddable.length === 0} onClick={() => void addTokens(selectedAddable.map((t) => t.id))}>
                {selectedAddable.length > 0 ? `Aggiungi i selezionati (${selectedAddable.length})` : "Aggiungi i selezionati"}
              </Button>
              <Menu
                label="Aggiungi un token al combattimento"
                items={addMenu.length ? addMenu : [{ id: "none", label: "Tutti i token sono già nel combattimento", disabled: true }]}
                trigger={
                  <Button size="sm" variant="gray" icon={<Plus size={16} />}>
                    Aggiungi token
                  </Button>
                }
              />
            </div>
            <form
              className="c-tracker__row2"
              onSubmit={(e) => {
                e.preventDefault();
                void addEntry();
              }}
            >
              <TextField label="Voce libera" placeholder="Trappola, evento..." value={entryName} onChange={(e) => setEntryName(e.target.value)} autoComplete="off" />
              <TextField label="Iniziativa" inputMode="decimal" value={entryInit} onChange={(e) => setEntryInit(e.target.value)} autoComplete="off" />
              <Toggle label="Nascosta ai giocatori" checked={entryHidden} onCheckedChange={setEntryHidden} />
              <Button type="submit" size="sm" variant="gray" icon={<Plus size={16} />}>
                Aggiungi voce
              </Button>
            </form>
          </section>

          <section className="c-tracker__section" aria-label="Tiro dell'iniziativa">
            <div className="c-tracker__roll">
              <TextField label="Bonus" inputMode="numeric" value={bonus} onChange={(e) => setBonus(e.target.value)} autoComplete="off" />
              <SegmentedControl
                aria-label="Modo del tiro"
                value={mode}
                onValueChange={setMode}
                options={[
                  { value: "normal", label: "Normale" },
                  { value: "advantage", label: "Vantaggio" },
                  { value: "disadvantage", label: "Svantaggio" }
                ]}
              />
            </div>
            <Toggle label="Ordina per iniziativa dopo il tiro" checked={sortAfter} onCheckedChange={setSortAfter} />
            <div className="c-tracker__bar">
              <Button size="sm" variant="tinted" icon={<Dices size={16} />} disabled={missing.length === 0} onClick={() => void roll(missing.map((p) => p.id))}>
                Tira per chi manca ({missing.length})
              </Button>
              <Button size="sm" variant="gray" icon={<Dices size={16} />} disabled={count === 0} onClick={() => void roll((combat?.participants ?? []).map((p) => p.id))}>
                Tira per tutti
              </Button>
            </div>
            <p className="t-caption1 a-muted c-hint">Il tiro (d20 più bonus) lo fa il server. Puoi anche scrivere il valore a mano accanto a ogni voce.</p>
          </section>
        </>
      ) : null}

      {combat && count > 0 ? (
        <Order combat={combat} isGm={isGm} sceneId={sceneId} onRoll={(id) => void roll([id])} />
      ) : (
        <p className="t-subhead a-muted c-tracker__empty">
          {isGm ? "Aggiungi i token del combattimento: le iniziative si tirano o si scrivono a mano." : "Nessun combattimento in corso."}
        </p>
      )}

      <Alert
        open={confirmEnd}
        onOpenChange={setConfirmEnd}
        title="Terminare il combattimento?"
        message="Gli effetti con durata finiscono con lui. Puoi annullare subito dopo con Annulla (Cmd/Ctrl+Z)."
        actions={[
          { label: "Annulla", role: "cancel" },
          { label: "Termina", role: "destructive", onPress: () => void run({ type: "combat.end", sceneId }) }
        ]}
      />
    </div>
  );
}

interface OrderProps {
  combat: CombatView;
  isGm: boolean;
  sceneId: string;
  onRoll: (participantId: string) => void;
}

interface Drag {
  id: string;
  from: number;
  to: number;
  rects: Array<{ top: number; height: number }>;
}

function Order({ combat, isGm, sceneId, onRoll }: OrderProps) {
  const { run } = useCommands();
  const list = useRef<HTMLOListElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [live, setLive] = useState("");
  const shown = drag ? previewOrder(combat.participants, drag.from, drag.to) : combat.participants;

  function startDrag(e: PointerEvent<HTMLButtonElement>, p: ParticipantView, index: number) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const rows = [...(list.current?.querySelectorAll<HTMLElement>(":scope > li") ?? [])];
    const rects = rows.map((r) => {
      const b = r.getBoundingClientRect();
      return { top: b.top, height: b.height };
    });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* puntatore gia' rilasciato */
    }
    setDrag({ id: p.id, from: index, to: index, rects });
  }

  function moveDrag(e: PointerEvent<HTMLButtonElement>) {
    if (!drag) return;
    const to = dropIndex(drag.rects, e.clientY);
    if (to !== drag.to) setDrag({ ...drag, to });
  }

  function endDrag(e: PointerEvent<HTMLButtonElement>, commit: boolean) {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* gia' rilasciato */
    }
    if (commit && d.to !== d.from) void run(reorderCommand(sceneId, d.id, d.to));
  }

  function keyMove(e: KeyboardEvent<HTMLButtonElement>, p: ParticipantView, index: number) {
    const delta = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (!delta) return;
    e.preventDefault();
    const to = movedIndex(index, delta, combat.participants.length);
    if (to === null) return;
    setLive(`${p.name}: posizione ${to + 1} di ${combat.participants.length}`);
    void run(reorderCommand(sceneId, p.id, to));
  }

  return (
    <>
      <ol ref={list} className="c-order" aria-label="Ordine di iniziativa">
        {shown.map((p, i) => {
          const original = combat.participants.findIndex((x) => x.id === p.id);
          const turn = combat.started && combat.turnId === p.id;
          return (
            <li
              key={p.id}
              className={["c-row", drag?.id === p.id ? "c-row--dragging" : "", p.hidden ? "c-row--muted" : ""].filter(Boolean).join(" ")}
              aria-current={turn ? "true" : undefined}
            >
              {isGm ? (
                <IconButton
                  label={`Sposta ${p.name}: trascina, oppure frecce su e giù`}
                  variant="plain"
                  className="c-row__handle"
                  icon={<GripVertical size={18} />}
                  onPointerDown={(e) => startDrag(e, p, original)}
                  onPointerMove={moveDrag}
                  onPointerUp={(e) => endDrag(e, true)}
                  onPointerCancel={(e) => endDrag(e, false)}
                  onKeyDown={(e) => keyMove(e, p, original)}
                />
              ) : null}
              <div className="c-row__name">
                <span className="t-body c-row__title">{p.name}</span>
                <span className="t-caption1 a-muted c-row__sub">
                  {turn ? <Badge tone="tint">Di turno</Badge> : null}
                  {p.tokenId === null ? <span>Voce libera</span> : null}
                  {isGm && p.hidden ? <Badge tone="gray">Nascosto ai giocatori</Badge> : null}
                  {isGm && p.hideInitiative ? <Badge tone="gray">Valore nascosto</Badge> : null}
                </span>
              </div>
              {isGm ? (
                <InitiativeField sceneId={sceneId} participant={p} />
              ) : (
                <span className="t-headline c-row__initvalue" aria-label={p.initiative === null ? "Iniziativa non nota" : `Iniziativa ${formatInitiative(p.initiative)}`}>
                  {p.initiative === null ? "–" : formatInitiative(p.initiative)}
                </span>
              )}
              {isGm ? (
                <span className="c-row__tools">
                  <IconButton label={`Tira l'iniziativa di ${p.name}`} variant="plain" icon={<Dices size={18} />} onClick={() => onRoll(p.id)} />
                  <Menu
                    label={`Altre azioni per ${p.name}`}
                    placement="bottom-end"
                    items={[
                      { id: "hidden", label: "Nascosto ai giocatori", icon: p.hidden ? <EyeOff size={16} /> : <Eye size={16} />, checked: !!p.hidden, onSelect: () => void run({ type: "combat.update", sceneId, participantId: p.id, patch: { hidden: !p.hidden } }) },
                      { id: "hideInit", label: "Nascondi il valore", checked: !!p.hideInitiative, onSelect: () => void run({ type: "combat.update", sceneId, participantId: p.id, patch: { hideInitiative: !p.hideInitiative } }) },
                      { id: "remove", label: "Togli dal combattimento", destructive: true, icon: <Swords size={16} />, onSelect: () => void run({ type: "combat.remove", sceneId, participantId: p.id }) }
                    ]}
                    trigger={<IconButton label={`Altre azioni per ${p.name}`} variant="plain" icon={<MoreHorizontal size={18} />} />}
                  />
                </span>
              ) : null}
              <span className="l-sr-only">{`Posizione ${i + 1}`}</span>
            </li>
          );
        })}
      </ol>
      <p className="l-sr-only" role="status" aria-live="polite">
        {live}
      </p>
    </>
  );
}

/** Campo del valore: si scrive a mano e si conferma con Invio o uscendo dal campo. */
function InitiativeField({ sceneId, participant }: { sceneId: string; participant: ParticipantView }) {
  const { run } = useCommands();
  const toast = useToast();
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? formatInitiative(participant.initiative);

  async function commit() {
    if (text === null) return;
    const value = parseInitiative(text);
    setText(null);
    if (value === "invalid") {
      toast.show({ title: "Iniziativa non valida", message: "Un numero da -1000 a 1000, oppure vuoto.", tone: "warning" });
      return;
    }
    if (value === participant.initiative) return;
    await run(value === null ? clearInitiativeCommand(sceneId, participant.id) : setInitiativeCommand(sceneId, participant.id, value));
  }

  return (
    <input
      className="c-initfield"
      inputMode="decimal"
      aria-label={`Iniziativa di ${participant.name}`}
      placeholder="–"
      value={shown}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void commit();
        } else if (e.key === "Escape") setText(null);
      }}
    />
  );
}
