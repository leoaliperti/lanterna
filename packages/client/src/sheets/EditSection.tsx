import { useState } from "react";
import { Link2, Plus, Trash2 } from "lucide-react";
import { ABILITIES, SKILLS, SKILL_ABILITY, skillProficiency, type Ability, type ClassEntry, type Proficiency, type Skill, type TokenView } from "@lanterna/shared";
import { Alert, Banner, Button, IconButton, Picker, TextField, Toggle } from "../ui";
import { NumInput, type SectionProps } from "./fields";
import { ABILITY_LABEL, ABILITY_SHORT, CASTER_LABEL, SIZE_LABEL, SKILL_LABEL, SKILL_PROFICIENCY_OPTIONS, patchSheet } from "./sheetLogic";

export interface EditSectionProps extends SectionProps {
  isGm: boolean;
  ownerUserId: string | null;
  tokenId: string | null;
  players: Array<{ userId: string; displayName: string }>;
  tokens: readonly TokenView[];
  onMeta: (patch: { ownerUserId?: string | null; tokenId?: string | null }) => void;
  onSyncFromToken: (() => void) | null;
  onDelete: () => void;
}

const HIT_DICE = [4, 6, 8, 10, 12];

/**
 * Editor dei dati: nome, taglia, livello (inserito a mano: niente punti esperienza), classi, caratteristiche, competenze,
 * bonus. I valori derivati (modificatori, CA, PF massimi...) si ricalcolano da soli. Il GM vede anche proprietario,
 * token collegato ed eliminazione.
 */
export function EditSection(props: EditSectionProps) {
  const { doc, kind, change, derived, isGm, ownerUserId, tokenId, players, tokens, onMeta, onSyncFromToken, onDelete } = props;
  const s = doc.sheet;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const totalLevel = s.classes.reduce((n, c) => n + c.level, 0);

  const setClass = (i: number, patch: Partial<ClassEntry>) =>
    change((d) => patchSheet(d, { classes: d.sheet.classes.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));

  return (
    <div className="s-stack">
      <section className="s-block" aria-labelledby="s-e-id">
        <h3 id="s-e-id" className="t-headline">
          Identita'
        </h3>
        <TextField label="Nome" value={s.name} maxLength={200} onChange={(e) => change((d) => patchSheet(d, { name: e.target.value }))} />
        <Picker
          showLabel
          label="Taglia"
          value={s.size}
          onValueChange={(v) => change((d) => patchSheet(d, { size: v }))}
          options={(Object.keys(SIZE_LABEL) as Array<keyof typeof SIZE_LABEL>).map((k) => ({ value: k, label: SIZE_LABEL[k] }))}
        />
        <p className="t-footnote a-muted">Livello totale: {derived.level}. Si imposta a mano nelle classi: Lanterna non gestisce i punti esperienza.</p>
      </section>

      <section className="s-block" aria-labelledby="s-e-cl">
        <h3 id="s-e-cl" className="t-headline">
          Classi e livello
        </h3>
        {s.classes.map((c, i) => (
          <fieldset key={i} className="s-form s-fieldset">
            <legend className="t-subhead">Classe {i + 1}</legend>
            <TextField label="Nome della classe" value={c.id} maxLength={64} onChange={(e) => setClass(i, { id: e.target.value || "classe" })} />
            <NumInput label="Livello" value={c.level} min={1} max={Math.max(1, 20 - (totalLevel - c.level))} onValueChange={(n) => setClass(i, { level: n })} />
            <Picker
              showLabel
              label="Dado vita"
              value={String(c.hitDie ?? 8)}
              onValueChange={(v) => setClass(i, { hitDie: Number(v) })}
              options={HIT_DICE.map((d) => ({ value: String(d), label: `d${d}` }))}
            />
            <Picker
              showLabel
              label="Incantatore"
              value={c.casterKind ?? "none"}
              onValueChange={(v) =>
                change((d) =>
                  patchSheet(d, {
                    classes: d.sheet.classes.map((x, j) => {
                      if (j !== i) return x;
                      const { casterKind: _k, spellcastingAbility: _a, ...rest } = x;
                      void _k;
                      void _a;
                      return v === "none" ? rest : { ...rest, casterKind: v, spellcastingAbility: x.spellcastingAbility ?? "int" };
                    })
                  })
                )
              }
              options={[{ value: "none", label: "Non lancia" }, ...(Object.keys(CASTER_LABEL) as Array<keyof typeof CASTER_LABEL>).map((k) => ({ value: k, label: CASTER_LABEL[k] }))]}
            />
            {c.casterKind ? (
              <Picker
                showLabel
                label="Caratteristica da incantatore"
                value={c.spellcastingAbility ?? "int"}
                onValueChange={(v) => setClass(i, { spellcastingAbility: v })}
                options={ABILITIES.map((a) => ({ value: a, label: ABILITY_LABEL[a] }))}
              />
            ) : null}
            {s.classes.length > 1 ? (
              <IconButton label={`Rimuovi la classe ${c.id}`} icon={<Trash2 size={16} />} onClick={() => change((d) => patchSheet(d, { classes: d.sheet.classes.filter((_, j) => j !== i) }))} />
            ) : null}
          </fieldset>
        ))}
        {totalLevel < 20 && s.classes.length < 6 ? (
          <Button variant="gray" size="sm" icon={<Plus size={16} />} onClick={() => change((d) => patchSheet(d, { classes: [...d.sheet.classes, { id: "classe", level: 1, hitDie: 8, hitDiceSpent: 0 }] }))}>
            Aggiungi una classe
          </Button>
        ) : null}
      </section>

      <section className="s-block" aria-labelledby="s-e-ab">
        <h3 id="s-e-ab" className="t-headline">
          Caratteristiche e tiri salvezza
        </h3>
        <div className="s-grid2">
          {ABILITIES.map((a: Ability) => (
            <div key={a} className="s-form">
              <NumInput label={ABILITY_LABEL[a]} value={s.abilities[a]} min={1} max={30} onValueChange={(n) => change((d) => patchSheet(d, { abilities: { ...d.sheet.abilities, [a]: n } }))} />
              <Toggle
                label={`Salvezza ${ABILITY_LABEL[a]}`}
                checked={s.saveProficiencies.includes(a)}
                onCheckedChange={(on) => change((d) => patchSheet(d, { saveProficiencies: on ? [...d.sheet.saveProficiencies, a] : d.sheet.saveProficiencies.filter((x) => x !== a) }))}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="s-block" aria-labelledby="s-e-sk">
        <h3 id="s-e-sk" className="t-headline">
          Competenze nelle abilita'
        </h3>
        <div className="s-grid2">
          {(SKILLS as readonly Skill[]).map((k) => (
            <Picker
              key={k}
              label={`${SKILL_LABEL[k]} (${ABILITY_SHORT[SKILL_ABILITY[k]]})`}
              showLabel
              value={skillProficiency(s.skills[k])}
              onValueChange={(v: Proficiency) => change((d) => patchSheet(d, { skills: { ...d.sheet.skills, [k]: v } }))}
              options={[...SKILL_PROFICIENCY_OPTIONS]}
            />
          ))}
        </div>
      </section>

      <section className="s-block" aria-labelledby="s-e-prof">
        <h3 id="s-e-prof" className="t-headline">
          Competenze in armi e strumenti
        </h3>
        <div className="s-grid2">
          <ProficiencyList label="Armi" items={s.proficiencies.weapons} onChange={(weapons) => change((d) => patchSheet(d, { proficiencies: { ...d.sheet.proficiencies, weapons } }))} />
          <ProficiencyList label="Strumenti" items={s.proficiencies.tools} onChange={(tools) => change((d) => patchSheet(d, { proficiencies: { ...d.sheet.proficiencies, tools } }))} />
        </div>
      </section>

      <section className="s-block" aria-labelledby="s-e-num">
        <h3 id="s-e-num" className="t-headline">
          Valori e bonus
        </h3>
        <div className="s-grid2">
          <NumInput label="Velocita' base (ft)" value={s.baseSpeed} min={0} max={500} onValueChange={(n) => change((d) => patchSheet(d, { baseSpeed: n }))} />
          <NumInput label="Bonus alla CA" value={s.acBonus} min={-20} max={30} onValueChange={(n) => change((d) => patchSheet(d, { acBonus: n }))} />
          <NumInput label="Bonus all'iniziativa" value={s.initiativeBonus} min={-20} max={30} onValueChange={(n) => change((d) => patchSheet(d, { initiativeBonus: n }))} />
          <NumInput label="Bonus PF per livello" value={s.hpBonusPerLevel} min={-50} max={9999} onValueChange={(n) => change((d) => patchSheet(d, { hpBonusPerLevel: n }))} />
        </div>
        <Toggle label="Scudo" checked={s.equipment.shield} onCheckedChange={(on) => change((d) => patchSheet(d, { equipment: { ...d.sheet.equipment, shield: on } }))} />
        <p className="t-footnote a-muted">
          PF massimi: {derived.hpMax} (media fissa dei dadi vita, Costituzione e bonus). CA: {derived.armorClass}.
        </p>
      </section>

      {isGm ? (
        <section className="s-block" aria-labelledby="s-e-gm">
          <h3 id="s-e-gm" className="t-headline">
            <Link2 size={16} aria-hidden="true" /> Solo GM
          </h3>
          {kind === "pc" ? (
            <Picker
              showLabel
              label="Giocatore proprietario"
              value={ownerUserId ?? "none"}
              onValueChange={(v) => onMeta({ ownerUserId: v === "none" ? null : v })}
              options={[{ value: "none", label: "Nessuno" }, ...players.map((p) => ({ value: p.userId, label: p.displayName }))]}
            />
          ) : null}
          <Picker
            showLabel
            label="Token collegato"
            value={tokenId ?? "none"}
            onValueChange={(v) => onMeta({ tokenId: v === "none" ? null : v })}
            options={[{ value: "none", label: "Nessuno" }, ...tokens.map((t) => ({ value: t.id, label: t.name }))]}
          />
          <Banner tone="info" title="PF e condizioni">
            La scheda e' la fonte di verita': quando cambiano PF o condizioni, il GM aggiorna la barra del token collegato.
          </Banner>
          {onSyncFromToken ? (
            <Button variant="gray" size="sm" onClick={onSyncFromToken}>
              Copia i PF dal token alla scheda
            </Button>
          ) : null}
          <Button variant="destructive" size="sm" icon={<Trash2 size={16} />} onClick={() => setConfirmDelete(true)}>
            Elimina la scheda
          </Button>
          <Alert
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title="Eliminare la scheda?"
            message="L'operazione non si puo' annullare."
            actions={[
              { label: "Annulla", role: "cancel" },
              { label: "Elimina", role: "destructive", onPress: onDelete }
            ]}
          />
        </section>
      ) : null}
    </div>
  );
}

/** Elenco di competenze (armi o strumenti) con aggiunta da campo di testo e rimozione per voce. */
function ProficiencyList({ label, items, onChange }: { label: string; items: readonly string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const value = draft.trim();
    if (!value || items.includes(value)) return;
    onChange([...items, value]);
    setDraft("");
  };
  return (
    <div className="s-form">
      <TextField
        label={`Nuova competenza (${label.toLowerCase()})`}
        value={draft}
        maxLength={60}
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
      />
      <Button variant="gray" size="sm" icon={<Plus size={16} />} onClick={add} disabled={!draft.trim()}>
        Aggiungi a {label.toLowerCase()}
      </Button>
      {items.length === 0 ? <p className="t-footnote a-muted">Nessuna {label.toLowerCase()} registrata.</p> : null}
      <ul className="s-list-plain" aria-label={`Competenze in ${label.toLowerCase()}`}>
        {items.map((item) => (
          <li key={item} className="s-chip-row">
            <span>{item}</span>
            <IconButton label={`Rimuovi ${item}`} icon={<Trash2 size={16} />} variant="plain" onClick={() => onChange(items.filter((x) => x !== item))} />
          </li>
        ))}
      </ul>
    </div>
  );
}
