import { createContext, useContext, useState, type FormEvent } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import type { CampaignSummary } from "@lanterna/shared";
import { userErrorMessage } from "../api/client";
import { Button, Menu, Sheet, TextField, type MenuItemSpec } from "../ui";

/** Campagne dell'utente e quella aperta: le fornisce la schermata del tavolo (nessuna campagna = nessun selettore). */
export interface CampaignChoice {
  campaigns: readonly CampaignSummary[];
  currentId: string;
  /** Apre un'altra campagna. */
  onSelect: (id: string) => void;
  /** Solo admin (il server verifica comunque): crea e apre una nuova campagna. */
  onCreate?: (name: string) => Promise<void>;
}

export const CampaignChoiceContext = createContext<CampaignChoice | null>(null);

/**
 * Titolo della campagna che, se l'utente ne ha piu' di una (o puo' crearne), diventa un menu per cambiare.
 * Il cambio e' solo navigazione (`#/?campaign=<id>`): cosa vede ciascuno lo decide il server.
 */
export function CampaignSwitcher({ title }: { title: string }) {
  const choice = useContext(CampaignChoiceContext);
  const [creating, setCreating] = useState(false);
  if (!choice || (choice.campaigns.length < 2 && !choice.onCreate)) {
    return <h1 className="t-headline a-topbar__campaign">{title}</h1>;
  }
  const items: MenuItemSpec[] = [
    ...choice.campaigns.map(
      (c): MenuItemSpec => ({
        id: c.id,
        label: c.name,
        icon: c.id === choice.currentId ? <Check size={18} /> : undefined,
        onSelect: () => choice.onSelect(c.id)
      })
    ),
    ...(choice.onCreate ? [{ id: "new", label: "Nuova campagna", icon: <Plus size={18} />, onSelect: () => setCreating(true) } satisfies MenuItemSpec] : [])
  ];
  return (
    <>
      <Menu
        label="Campagne"
        items={items}
        trigger={
          <button type="button" className="a-topbar__switch" aria-label={`Campagna: ${title}. Cambia campagna`}>
            <h1 className="t-headline a-topbar__campaign">{title}</h1>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        }
      />
      {choice.onCreate ? <NewCampaignSheet open={creating} onOpenChange={setCreating} onCreate={choice.onCreate} /> : null}
    </>
  );
}

function NewCampaignSheet({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Dai un nome alla campagna.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate(trimmed);
      setName("");
      onOpenChange(false);
    } catch (err) {
      setError(userErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Nuova campagna">
      <form className="a-form" noValidate onSubmit={(e) => void submit(e)}>
        <TextField label="Nome della campagna" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoComplete="off" error={error ?? undefined} />
        <div className="a-form__actions">
          <Button variant="gray" onClick={() => onOpenChange(false)} disabled={busy}>
            Annulla
          </Button>
          <Button type="submit" loading={busy}>
            Crea
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
