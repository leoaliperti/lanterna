import { useState, type FormEvent } from "react";
import { Banner, Button, SecureField, Sheet, useToast } from "../ui";
import { changePassword, passwordErrorMessage } from "../api/client";
import { PASSWORD_REQUIREMENT, passwordProblem } from "./passwords";

export function ChangePasswordSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Cambia password">
      <ChangePasswordForm onDone={() => onOpenChange(false)} />
    </Sheet>
  );
}

function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentError = submitted && current === "" ? "Inserisci la password attuale." : undefined;
  const nextError = submitted ? (passwordProblem(next) ?? undefined) : undefined;
  const confirmError = submitted && !nextError && confirm !== next ? "Le due password non coincidono." : undefined;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (busy || current === "" || passwordProblem(next) || confirm !== next) return;
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      toast.show({ title: "Password aggiornata", tone: "success" });
      onDone();
    } catch (err) {
      setError(passwordErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form className="a-form" onSubmit={onSubmit} noValidate>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <SecureField label="Password attuale" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} error={currentError} />
      <SecureField
        label="Nuova password"
        autoComplete="new-password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        helper={PASSWORD_REQUIREMENT}
        error={nextError}
      />
      <SecureField label="Ripeti la nuova password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={confirmError} />
      <Button type="submit" size="lg" fullWidth loading={busy}>
        Aggiorna password
      </Button>
    </form>
  );
}
