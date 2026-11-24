import { useState } from "react";
import { Backpack, BookOpen, Plus, Shield, Trash2 } from "lucide-react";
import { inventoryWeight, type SheetItem } from "@lanterna/shared";
import { Badge, Button, IconButton, List, ListRow, Picker, Stepper, TextField, Toggle } from "../ui";
import { EmptyState } from "../screens/EmptyState";
import { NumInput, type SectionProps } from "./fields";
import { itemFromContent } from "./fromContent";
import { LibraryPicker } from "./LibraryPicker";
import { matchesQuery, newId, patchSheet } from "./sheetLogic";

const ARMOR_LABEL = { light: "Leggera", medium: "Media", heavy: "Pesante" } as const;

/** Inventario e carico: oggetti con quantità e peso, armatura indossata (la CA si ricalcola), confronto con la capacità. */
export function InventorySection({ doc, derived, change, query }: SectionProps) {
  const [mode, setMode] = useState<"none" | "library" | "manual">("none");
  const [name, setName] = useState("");
  const [qty, setQty] = useState(1);
  const [weight, setWeight] = useState(0);
  const [armor, setArmor] = useState<"" | "light" | "medium" | "heavy">("");
  const [baseAc, setBaseAc] = useState(11);

  const items = doc.extras.inventory.filter((i) => matchesQuery(query, i.name, i.notes));
  const total = inventoryWeight(doc.extras);
  const worn = doc.sheet.equipment.armorId;

  const setItems = (fn: (list: SheetItem[]) => SheetItem[]) => change((d) => ({ ...d, extras: { ...d.extras, inventory: fn(d.extras.inventory) } }));
  const patchItem = (id: string, patch: Partial<SheetItem>) => setItems((l) => l.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const wear = (id: string | null) =>
    change((d) => patchSheet(d, { equipment: { shield: d.sheet.equipment.shield, ...(id ? { armorId: id } : {}) } }));

  return (
    <div className="s-stack">
      <p className="s-weight" aria-live="polite">
        <Backpack size={16} aria-hidden="true" /> Carico: <strong>{total} lb</strong> su {derived.carrying.carry} lb
        {derived.carrying.overCapacity ? <Badge tone="orange">Oltre la capacità</Badge> : null}
      </p>

      {items.length === 0 ? (
        <EmptyState
          icon={<Backpack size={28} />}
          title={doc.extras.inventory.length === 0 ? "Zaino vuoto" : "Nessun risultato"}
          description={doc.extras.inventory.length === 0 ? "Aggiungi oggetti dalla libreria importata o a mano." : "Nessun oggetto corrisponde alla ricerca."}
        />
      ) : (
        <List aria-label="Oggetti">
          {items.map((i) => (
            <ListRow
              key={i.id}
              title={i.name}
              subtitle={`${i.quantity} × ${i.weight} lb${i.armor ? ` · Armatura ${ARMOR_LABEL[i.armor.category].toLowerCase()}, CA ${i.armor.baseAc}` : ""}`}
              trailing={
                <span className="s-row">
                  {worn === i.id ? <Badge tone="green">Indossata</Badge> : null}
                  <Stepper label={`Quantità di ${i.name}`} value={i.quantity} min={0} max={9999} onValueChange={(n) => patchItem(i.id, { quantity: n })} />
                  {i.armor ? (
                    <IconButton label={worn === i.id ? `Togli ${i.name}` : `Indossa ${i.name}`} icon={<Shield size={16} />} aria-pressed={worn === i.id} onClick={() => wear(worn === i.id ? null : i.id)} />
                  ) : null}
                  <IconButton
                    label={`Rimuovi ${i.name}`}
                    icon={<Trash2 size={16} />}
                    onClick={() => {
                      setItems((l) => l.filter((x) => x.id !== i.id));
                      if (worn === i.id) wear(null);
                    }}
                  />
                </span>
              }
            />
          ))}
        </List>
      )}

      <div className="s-actions">
        <Button variant="gray" size="sm" icon={<BookOpen size={16} />} onClick={() => setMode(mode === "library" ? "none" : "library")} aria-expanded={mode === "library"}>
          Dalla libreria
        </Button>
        <Button variant="gray" size="sm" icon={<Plus size={16} />} onClick={() => setMode(mode === "manual" ? "none" : "manual")} aria-expanded={mode === "manual"}>
          A mano
        </Button>
      </div>
      {mode === "library" ? <LibraryPicker kind="item" onPick={(d) => setItems((l) => [...l, itemFromContent(d)])} /> : null}
      {mode === "manual" ? (
        <form
          className="s-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            const item: SheetItem = { id: newId(), name: name.trim(), quantity: qty, weight, equipped: false, notes: "", ...(armor ? { armor: { category: armor, baseAc } } : {}) };
            setItems((l) => [...l, item]);
            setName("");
          }}
        >
          <TextField label="Nome dell'oggetto" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
          <NumInput label="Quantità" value={qty} onValueChange={setQty} min={0} max={9999} />
          <NumInput label="Peso di uno (lb)" value={weight} onValueChange={setWeight} min={0} max={10000} step={0.25} />
          <Toggle label="È un'armatura" checked={armor !== ""} onCheckedChange={(on) => setArmor(on ? "light" : "")} />
          {armor ? (
            <>
              <Picker
                label="Categoria"
                value={armor}
                onValueChange={setArmor}
                options={[
                  { value: "light", label: "Leggera" },
                  { value: "medium", label: "Media" },
                  { value: "heavy", label: "Pesante" }
                ]}
              />
              <NumInput label="CA base dell'armatura" value={baseAc} onValueChange={setBaseAc} min={0} max={30} />
            </>
          ) : null}
          <Button type="submit" size="sm">
            Aggiungi
          </Button>
        </form>
      ) : null}
    </div>
  );
}
