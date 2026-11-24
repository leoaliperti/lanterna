import { useState } from "react";
import { Heart, Moon, Plus, Shield, Skull, Sun, Swords, Trash2 } from "lucide-react";
import {
  CONDITIONS,
  MAX_EXHAUSTION,
  addCondition,
  damageSheet,
  deathSaveSheet,
  decideInstantDeathSheet,
  resetDeathSheet,
  engineSheet,
  grantTempHpSheet,
  healSheet,
  hpStateOf,
  longRest,
  removeCondition,
  setExhaustion,
  shortRest,
  spendHitDie,
  stabilizeSheet,
  type ActiveCondition,
  type SheetAttack
} from "@lanterna/shared";
import { Alert, Badge, Button, IconButton, List, ListRow, Picker, ProgressView, Stepper, TextField, Toggle } from "../ui";
import { CONDITION_LABELS } from "../table/conditions";
import { NumInput, bonusLabel, type SectionProps } from "./fields";
import { ABILITY_LABEL, applySheetOp, firstDie, matchesQuery, modeNote, naturalD20, newId, rollTargetFor, signed } from "./sheetLogic";

/** Combattimento: CA, iniziativa, PF, dadi vita, tiri contro la morte, condizioni, attacchi e riposi. */
export function CombatSection(props: SectionProps) {
  const { doc, derived, roller, change, query } = props;
  const engine = engineSheet(doc);
  const hp = hpStateOf(engine.sheet, engine.content);
  const [amount, setAmount] = useState(1);
  const [rest, setRest] = useState<"short" | "long" | null>(null);
  const initiativeNote = modeNote(derived.initiative);
  const down = hp.current === 0 && !hp.dead;
  const show = (...t: string[]) => matchesQuery(query, ...t);

  const conditions = CONDITIONS.filter((c): c is ActiveCondition => c !== "exhaustion").filter((c) => show(CONDITION_LABELS[c], "condizioni"));
  const attacks = doc.extras.attacks.filter((a) => show(a.name, a.damageType, "attacco"));

  return (
    <div className="s-stack">
      <ul className="s-facts" aria-label="Valori di combattimento">
        <li>
          <span className="t-caption1 a-muted">
            <Shield size={12} aria-hidden="true" /> CA
          </span>
          <strong className="t-title3">{derived.armorClass}</strong>
        </li>
        <li>
          <button
            type="button"
            className="s-fact-btn"
            onClick={() => void roller.rollTarget({ kind: "initiative" }, "Iniziativa")}
            aria-label={`Iniziativa ${bonusLabel(derived.initiative)}. Tira`}
          >
            <span className="t-caption1 a-muted">Iniziativa</span>
            <strong className="t-title3">{signed(derived.initiative.modifier)}</strong>
            {initiativeNote ? <span className="t-caption2 a-muted">{initiativeNote}</span> : null}
          </button>
        </li>
        <li>
          <span className="t-caption1 a-muted">Velocità</span>
          <strong className="t-title3">{derived.speed} ft</strong>
        </li>
      </ul>

      <section className="s-block" aria-labelledby="s-hp">
        <h3 id="s-hp" className="t-headline">
          <Heart size={16} aria-hidden="true" /> Punti ferita
        </h3>
        <p className="s-hp__value" aria-live="polite">
          <strong className="t-title1">{hp.current}</strong> <span className="a-muted">/ {hp.max}</span>
          {hp.temp > 0 ? <Badge tone="tint">+{hp.temp} temporanei</Badge> : null}
          {hp.dead ? <Badge tone="red">Morto</Badge> : hp.instantDeathPending ? <Badge tone="red">Morte da decidere</Badge> : down ? <Badge tone="red">A terra</Badge> : hp.stable ? <Badge tone="orange">Stabile</Badge> : null}
        </p>
        <ProgressView value={hp.max > 0 ? hp.current / hp.max : 0} label="Punti ferita" />
        <div className="s-row">
          <NumInput label="Quantità" value={amount} onValueChange={setAmount} min={0} max={9999} className="s-row__grow" />
        </div>
        <div className="s-actions">
          <Button variant="destructive" size="sm" onClick={() => change((d) => applySheetOp(d, (s, c) => damageSheet(s, c, amount)))}>
            Danno
          </Button>
          <Button variant="tinted" size="sm" onClick={() => change((d) => applySheetOp(d, (s, c) => healSheet(s, c, amount)))}>
            Cura
          </Button>
          <Button variant="gray" size="sm" onClick={() => change((d) => applySheetOp(d, (s, c) => grantTempHpSheet(s, c, amount)))}>
            PF temporanei
          </Button>
        </div>
      </section>

      {down || hp.dead || hp.stable || hp.instantDeathPending || hp.deathSaves.failures + hp.deathSaves.successes > 0 ? (
        <section className="s-block" aria-labelledby="s-death">
          <h3 id="s-death" className="t-headline">
            <Skull size={16} aria-hidden="true" /> Tiri contro la morte
          </h3>
          <p>
            Successi {hp.deathSaves.successes}/3 &middot; Fallimenti {hp.deathSaves.failures}/3
          </p>
          {hp.instantDeathPending ? (
            <div className="s-stack" role="status">
              <p className="t-body">
                Il danno ha superato i PF massimi: la morte istantanea la decide il GM, non il sistema.
              </p>
              {props.isGm ? (
                <div className="s-actions">
                  <Button size="sm" variant="destructive" onClick={() => change((d) => applySheetOp(d, (s, c) => decideInstantDeathSheet(s, c, true)))}>
                    Il personaggio muore
                  </Button>
                  <Button size="sm" variant="gray" onClick={() => change((d) => applySheetOp(d, (s, c) => decideInstantDeathSheet(s, c, false)))}>
                    Resta a terra
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="s-actions">
            <Button
              size="sm"
              disabled={!down || hp.stable}
              onClick={() =>
                void roller.rollTargetThen({ kind: "deathSave" }, "Tiro contro la morte", (entry) => {
                  const natural = naturalD20(entry);
                  if (natural === null) return;
                  change((d) => applySheetOp(d, (s, c) => deathSaveSheet(s, c, natural, entry.total)));
                })
              }
            >
              Tira
            </Button>
            <Button variant="gray" size="sm" disabled={!down} onClick={() => change((d) => applySheetOp(d, (s, c) => stabilizeSheet(s, c)))}>
              Stabilizza
            </Button>
            <Button variant="gray" size="sm" onClick={() => change((d) => applySheetOp(d, (s, c) => resetDeathSheet(s, c)))}>
              Azzera stato di morte
            </Button>
          </div>
        </section>
      ) : null}

      <section className="s-block" aria-labelledby="s-hd">
        <h3 id="s-hd" className="t-headline">
          Dadi vita
        </h3>
        <ul className="s-list">
          {Object.entries(derived.hitDice).map(([die, v]) => (
            <li key={die} className="s-row">
              <span className="s-row__grow">
                d{die}: {v.remaining} su {v.total}
              </span>
              <Button
                variant="tinted"
                size="sm"
                disabled={v.remaining <= 0 || hp.dead}
                onClick={() =>
                  void roller.rollFormulaThen(`1d${die}`, `Dado vita d${die}`, (entry) => {
                    const rolled = firstDie(entry);
                    if (rolled === null) return;
                    change((d) => applySheetOp(d, (s, c) => spendHitDie(s, c, Number(die), rolled)));
                  })
                }
              >
                Spendi
              </Button>
            </li>
          ))}
        </ul>
        <div className="s-actions">
          <Button variant="gray" size="sm" icon={<Sun size={16} />} onClick={() => setRest("short")}>
            Riposo breve
          </Button>
          <Button variant="gray" size="sm" icon={<Moon size={16} />} onClick={() => setRest("long")}>
            Riposo lungo
          </Button>
        </div>
      </section>

      <section className="s-block" aria-labelledby="s-cond">
        <h3 id="s-cond" className="t-headline">
          Condizioni
        </h3>
        {show("Esaurimento") ? (
          <div className="s-row">
            <span className="s-row__grow">Esaurimento: livello {doc.sheet.exhaustion}</span>
            <Stepper
              label="Esaurimento"
              value={doc.sheet.exhaustion}
              min={0}
              max={MAX_EXHAUSTION}
              onValueChange={(n) => change((d) => applySheetOp(d, (s) => setExhaustion(s, n)))}
            />
          </div>
        ) : null}
        <div className="s-chips" role="group" aria-label="Condizioni attive">
          {conditions.map((c) => {
            const on = doc.sheet.conditions.includes(c);
            return (
              <button
                key={c}
                type="button"
                className="s-chip"
                aria-pressed={on}
                onClick={() => change((d) => applySheetOp(d, (s) => (on ? removeCondition(s, c) : addCondition(s, c))))}
              >
                {CONDITION_LABELS[c]}
              </button>
            );
          })}
        </div>
        {derived.conditionEffects.ownAttackMode !== "normal" || derived.conditionEffects.ownAbilityCheckMode !== "normal" ? (
          <p className="t-footnote a-muted">Le condizioni attive modificano vantaggio e svantaggio dei tuoi tiri.</p>
        ) : null}
      </section>

      <AttacksBlock {...props} attacks={attacks} />

      <Alert
        open={rest !== null}
        onOpenChange={(o) => !o && setRest(null)}
        title={rest === "long" ? "Riposo lungo" : "Riposo breve"}
        message={
          rest === "long"
            ? "PF al massimo, slot ripristinati, parte dei dadi vita recuperata e -1 Esaurimento. Serve almeno 1 PF."
            : "Gli slot del patto tornano disponibili. I dadi vita si spendono con il pulsante Spendi."
        }
        actions={[
          { label: "Annulla", role: "cancel" },
          {
            label: "Conferma",
            onPress: () => change((d) => applySheetOp(d, (s, c) => (rest === "long" ? longRest(s, c) : shortRest(s))))
          }
        ]}
      />
    </div>
  );
}

function AttacksBlock({ doc, roller, change, attacks }: SectionProps & { attacks: SheetAttack[] }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [ability, setAbility] = useState<SheetAttack["ability"]>("str");
  const [proficient, setProficient] = useState(true);
  const [bonus, setBonus] = useState(0);
  const [damage, setDamage] = useState("");

  const add = () => {
    if (!name.trim()) return;
    const attack: SheetAttack = { id: newId(), name: name.trim(), ability, proficient, bonus, damage: damage.trim(), damageType: "" };
    change((d) => ({ ...d, extras: { ...d.extras, attacks: [...d.extras.attacks, attack] } }));
    setName("");
    setDamage("");
    setBonus(0);
    setAdding(false);
  };

  return (
    <section className="s-block" aria-labelledby="s-att">
      <h3 id="s-att" className="t-headline">
        <Swords size={16} aria-hidden="true" /> Attacchi
      </h3>
      {attacks.length === 0 ? <p className="t-footnote a-muted">Nessun attacco. Aggiungine uno per tirare con un tocco.</p> : null}
      {attacks.length > 0 ? (
        <List aria-label="Attacchi">
          {attacks.map((a) => {
            const atk = bonusLabel(rollTargetFor(doc, { kind: "attack", ability: a.ability, proficient: a.proficient, bonus: a.bonus }));
            return (
              <ListRow
                key={a.id}
                title={a.name}
                subtitle={`${ABILITY_LABEL[a.ability]}${a.damage ? ` · ${a.damage}` : ""}${a.damageType ? ` ${a.damageType}` : ""}`}
                trailing={
                  <span className="s-row">
                    <Button
                      size="sm"
                      variant="tinted"
                      onClick={(e) => {
                        e.stopPropagation();
                        void roller.rollTarget({ kind: "attack", ability: a.ability, proficient: a.proficient, bonus: a.bonus }, `Attacco: ${a.name}`);
                      }}
                      aria-label={`Attacco con ${a.name}, ${atk}`}
                    >
                      {atk}
                    </Button>
                    {a.damage ? (
                      <Button
                        size="sm"
                        variant="gray"
                        onClick={(e) => {
                          e.stopPropagation();
                          void roller.rollFormula(a.damage, `Danno: ${a.name}`);
                        }}
                        aria-label={`Danno di ${a.name}, ${a.damage}`}
                      >
                        Danno
                      </Button>
                    ) : null}
                    <IconButton
                      label={`Elimina ${a.name}`}
                      icon={<Trash2 size={16} />}
                      onClick={(e) => {
                        e.stopPropagation();
                        change((d) => ({ ...d, extras: { ...d.extras, attacks: d.extras.attacks.filter((x) => x.id !== a.id) } }));
                      }}
                    />
                  </span>
                }
              />
            );
          })}
        </List>
      ) : null}
      {adding ? (
        <form
          className="s-form"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <TextField label="Nome dell'attacco" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
          <Picker
            label="Caratteristica"
            value={ability}
            onValueChange={setAbility}
            options={(Object.keys(ABILITY_LABEL) as SheetAttack["ability"][]).map((a) => ({ value: a, label: ABILITY_LABEL[a] }))}
          />
          <Toggle label="Competente" checked={proficient} onCheckedChange={setProficient} />
          <NumInput label="Bonus extra" value={bonus} onValueChange={setBonus} min={-20} max={40} />
          <TextField label="Formula di danno (es. 1d8+3)" value={damage} onChange={(e) => setDamage(e.target.value)} maxLength={100} />
          <div className="s-actions">
            <Button type="submit" size="sm">
              Aggiungi
            </Button>
            <Button variant="gray" size="sm" onClick={() => setAdding(false)}>
              Annulla
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="gray" size="sm" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
          Nuovo attacco
        </Button>
      )}
    </section>
  );
}
