import type { ToastInput } from "../ui";
import type { CommandResult } from "./RealtimeClient";

type Failure = Extract<CommandResult, { ok: false }>;

/** Toast leggero per un comando rifiutato. I messaggi del server sono fissi e non contengono dati. */
export function commandErrorToast(failure: Pick<Failure, "code" | "message">): ToastInput {
  switch (failure.code) {
    case "FORBIDDEN":
      return { title: "Azione non consentita", message: "Non hai il permesso di farlo.", tone: "warning" };
    case "INVALID":
      return { title: "Operazione non valida", message: capitalize(failure.message), tone: "danger" };
    case "CONFLICT":
      return { title: "Qualcosa è cambiato", message: "Lo stato del tavolo è cambiato nel frattempo: controlla e riprova.", tone: "warning" };
    case "NOT_FOUND":
      return { title: "Non trovato", message: "L'elemento non esiste più o non è disponibile.", tone: "warning" };
    case "RATE_LIMITED":
      return { title: "Troppo in fretta", message: "Hai inviato troppe richieste ravvicinate. Aspetta qualche secondo.", tone: "warning" };
    case "OFFLINE":
      return { title: "Sei offline", message: "Il comando non è stato inviato. Riprova appena torni online.", tone: "warning" };
    case "TIMEOUT":
      return { title: "Nessuna risposta", message: "Il server non ha risposto in tempo. Riprova.", tone: "danger" };
  }
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
