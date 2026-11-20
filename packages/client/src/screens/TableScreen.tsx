import { useState, type FormEvent } from "react";
import { Map as MapIcon, Sparkles } from "lucide-react";
import { Banner, Button, Spinner, TextField } from "../ui";
import { userErrorMessage } from "../api/client";
import { RealtimeProvider } from "../realtime/RealtimeProvider";
import { useSession } from "../session/SessionProvider";
import { Table } from "../table/Table";
import { TableFrame } from "../table/TableFrame";
import { useCampaigns } from "../table/useCampaigns";
import { EmptyState } from "./EmptyState";
import "./app.css";

/** Nome mostrato nella barra finche' la campagna non e' caricata. */
const FALLBACK_TITLE = "Campagna senza titolo";

/** Primo avvio: l'admin crea la sua prima campagna (il server verifica comunque il ruolo). */
function CreateFirstCampaign({ onCreate }: { onCreate: (name: string) => Promise<void> }) {
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
    } catch (err) {
      setError(userErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form className="a-onboard a-enter" onSubmit={(e) => void submit(e)} noValidate>
      <EmptyState
        icon={<Sparkles size={36} />}
        title="Crea la tua prima campagna"
        description="Ci vuole un nome. Poi potrai creare le scene, caricare le mappe e invitare i giocatori."
      />
      <TextField label="Nome della campagna" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoComplete="off" error={error ?? undefined} />
      <Button type="submit" loading={busy} fullWidth>
        Crea campagna
      </Button>
    </form>
  );
}

/** Tavolo: sceglie la campagna (la prima di quelle dell'utente) e apre la connessione in tempo reale. */
export function TableScreen() {
  const { user, logout } = useSession();
  const { state, reload, create } = useCampaigns();

  if (!user) return null;

  if (state.status === "ready" && state.campaigns[0]) {
    const campaign = state.campaigns[0];
    return (
      <RealtimeProvider key={campaign.id} campaignId={campaign.id} onSessionEnded={() => void logout().catch(() => undefined)}>
        <Table user={user} campaignName={campaign.name} />
      </RealtimeProvider>
    );
  }

  return (
    <TableFrame user={user} title={FALLBACK_TITLE}>
      {state.status === "loading" ? (
        <Spinner label="Caricamento delle campagne" size="lg" />
      ) : state.status === "error" ? (
        <div className="a-onboard">
          <Banner tone="danger" title="Non riesco a caricare le campagne">
            {state.message}
          </Banner>
          <Button variant="gray" onClick={reload}>
            Riprova
          </Button>
        </div>
      ) : user.role === "admin" ? (
        <CreateFirstCampaign onCreate={create} />
      ) : (
        <EmptyState
          icon={<MapIcon size={36} />}
          title="Nessuna campagna"
          description="Non fai ancora parte di nessuna campagna. Chiedi al GM di aggiungerti: comparirà qui."
        />
      )}
    </TableFrame>
  );
}
