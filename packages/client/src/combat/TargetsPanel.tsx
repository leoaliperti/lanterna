import { useMemo, useState } from "react";
import { Check, MoreHorizontal, Plus, Users } from "lucide-react";
import type { CampaignView, SceneView, TokenGroup } from "@lanterna/shared";
import { Button, IconButton, Menu, SearchField, Sheet, TextField, useToast } from "../ui";
import { useCommands } from "../realtime/RealtimeProvider";
import { ActionButtons } from "./ActionButtons";
import {
  KIND_LABELS,
  createGroupCommand,
  deleteGroupCommand,
  factionsOf,
  filterTokens,
  recallGroup,
  renameGroupCommand,
  replaceGroupTokensCommand,
  selectByCategory,
  toggleId,
  type ActionKind,
  type Category
} from "./selectionLogic";
import "./combat.css";

export interface TargetsPanelProps {
  view: CampaignView;
  scene: SceneView;
  selected: readonly string[];
  onSelect: (ids: readonly string[]) => void;
  onAction: (kind: ActionKind) => void;
}

const KINDS: Array<{ id: Category["kind"]; label: string }> = [
  { id: "all", label: "Tutti" },
  { id: "pc", label: "Solo PG" },
  { id: "monster", label: "Solo mostri" },
  { id: "object", label: "Solo oggetti" }
];

/**
 * Pannello dei bersagli (solo GM): selezione per categoria o fazione con un clic, gruppi salvati, elenco con
 * ricerca e azioni rapide sulla selezione. La selezione e' la stessa della mappa.
 */
export function TargetsPanel({ view, scene, selected, onSelect, onAction }: TargetsPanelProps) {
  const { run } = useCommands();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [groupSheet, setGroupSheet] = useState<{ mode: "create" } | { mode: "rename"; group: TokenGroup } | null>(null);
  const [groupName, setGroupName] = useState("");
  const tokens = useMemo(() => view.tokens.filter((t) => t.sceneId === scene.id), [view.tokens, scene.id]);
  const factions = useMemo(() => factionsOf(tokens, scene.id), [tokens, scene.id]);
  const shown = useMemo(() => filterTokens(tokens, query), [tokens, query]);
  const groups = view.groups ?? [];

  const pick = (cat: Category) => {
    const ids = selectByCategory(tokens, scene.id, cat).map((t) => t.id);
    onSelect(ids);
    if (ids.length === 0) toast.show({ title: "Nessun token corrisponde", tone: "info", duration: 2500 });
  };

  function openGroupSheet(sheet: NonNullable<typeof groupSheet>) {
    setGroupName(sheet.mode === "rename" ? sheet.group.name : "");
    setGroupSheet(sheet);
  }

  async function saveGroup() {
    if (!groupSheet) return;
    const cmd = groupSheet.mode === "create" ? createGroupCommand(crypto.randomUUID(), groupName, selected) : renameGroupCommand(groupSheet.group.id, groupName);
    if (!cmd) {
      toast.show({ title: groupSheet.mode === "create" ? "Serve un nome e almeno un token selezionato" : "Serve un nome", tone: "warning" });
      return;
    }
    if (await run(cmd)) setGroupSheet(null);
  }

  return (
    <div className="c-targets">
      <section className="c-targets__section" aria-label="Selezione per categoria">
        <h3 className="t-footnote a-muted c-targets__title">Seleziona</h3>
        <div className="c-chiprow">
          {KINDS.map((k) => (
            <button key={k.id} type="button" className="a-chip a-chip--sm" onClick={() => pick({ kind: k.id, faction: null })}>
              {k.label}
            </button>
          ))}
          {factions.map((f) => (
            <button key={f} type="button" className="a-chip a-chip--sm" onClick={() => pick({ kind: "all", faction: f })}>
              Fazione: {f}
            </button>
          ))}
          <button type="button" className="a-chip a-chip--sm" disabled={selected.length === 0} onClick={() => onSelect([])}>
            Nessuno
          </button>
        </div>
      </section>

      <section className="c-targets__section" aria-label="Gruppi salvati">
        <div className="c-effects__head">
          <h3 className="t-footnote a-muted c-targets__title">Gruppi</h3>
          <Button size="sm" variant="gray" icon={<Plus size={16} />} disabled={selected.length === 0} onClick={() => openGroupSheet({ mode: "create" })}>
            Salva la selezione
          </Button>
        </div>
        {groups.length === 0 ? <p className="t-caption1 a-muted c-hint">Nessun gruppo. Seleziona dei token e salvali: «Tutti i nemici», «Squadra A».</p> : null}
        <ul className="c-groups" aria-label="Elenco dei gruppi">
          {groups.map((g) => {
            const here = recallGroup(g, tokens, scene.id);
            return (
              <li key={g.id} className="c-group">
                <Button variant="gray" className="c-group__main" icon={<Users size={16} />} onClick={() => onSelect(here)}>
                  {g.name} ({here.length})
                </Button>
                <Menu
                  label={`Azioni sul gruppo ${g.name}`}
                  placement="bottom-end"
                  items={[
                    { id: "rename", label: "Rinomina", onSelect: () => openGroupSheet({ mode: "rename", group: g }) },
                    {
                      id: "replace",
                      label: "Sostituisci con la selezione",
                      disabled: selected.length === 0,
                      onSelect: () => {
                        const cmd = replaceGroupTokensCommand(g.id, selected);
                        if (cmd) void run(cmd);
                      }
                    },
                    { id: "delete", label: "Elimina il gruppo", destructive: true, onSelect: () => void run(deleteGroupCommand(g.id)) }
                  ]}
                  trigger={<IconButton label={`Azioni sul gruppo ${g.name}`} variant="plain" icon={<MoreHorizontal size={18} />} />}
                />
              </li>
            );
          })}
        </ul>
      </section>

      <section className="c-targets__section" aria-label="Azioni sulla selezione">
        <h3 className="t-footnote a-muted c-targets__title" role="status" aria-live="polite">
          {selected.length === 0 ? "Nessun token selezionato" : selected.length === 1 ? "1 token selezionato" : `${selected.length} token selezionati`}
        </h3>
        <ActionButtons onAction={onAction} disabled={selected.length === 0} />
      </section>

      <section className="c-targets__section" aria-label="Elenco dei bersagli">
        <SearchField placeholder="Cerca per nome, fazione o tipo" label="Cerca un bersaglio" value={query} onValueChange={setQuery} />
        {shown.length === 0 ? <p className="t-subhead a-muted c-tracker__empty">Nessun token.</p> : null}
        <ul className="c-targetlist" aria-label="Token della scena">
          {shown.map((t) => {
            const on = selected.includes(t.id);
            return (
              <li key={t.id}>
                <button type="button" className="c-target" aria-pressed={on} onClick={() => onSelect(toggleId(selected, t.id))}>
                  <span className="c-target__box" aria-hidden="true">
                    {on ? <Check size={14} /> : null}
                  </span>
                  <span className="c-target__name">
                    <span className="t-body c-target__title">{t.name}</span>
                    <span className="t-caption1 a-muted">
                      {KIND_LABELS[t.kind]}
                      {t.faction ? `, ${t.faction}` : ""}
                      {t.hidden ? ", nascosto" : ""}
                    </span>
                  </span>
                  <span className="t-footnote a-muted">{t.health ? `${t.health.current}/${t.health.max}` : ""}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <Sheet open={groupSheet !== null} onOpenChange={(o) => !o && setGroupSheet(null)} title={groupSheet?.mode === "rename" ? "Rinomina il gruppo" : "Nuovo gruppo"}>
        <form
          className="c-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void saveGroup();
          }}
        >
          <TextField label="Nome del gruppo" value={groupName} onChange={(e) => setGroupName(e.target.value)} autoComplete="off" autoFocus />
          {groupSheet?.mode === "create" ? <p className="t-caption1 a-muted c-hint">Contiene i {selected.length} token selezionati.</p> : null}
          <div className="c-form__actions">
            <Button variant="gray" onClick={() => setGroupSheet(null)}>
              Annulla
            </Button>
            <Button type="submit">Salva</Button>
          </div>
        </form>
      </Sheet>
    </div>
  );
}

