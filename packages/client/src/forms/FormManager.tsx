import { useState } from "react";
import { Button, Banner, Sheet, useToast } from "../ui";
import { deleteForm, uploadFormPdf } from "./formApi";
import { FormCalibrator } from "./FormCalibrator";
import { useFormTemplate } from "./useFormTemplate";
import { ApiRequestError } from "../api/client";

export interface FormManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaignId: string;
}

/**
 * Gestione del modulo del GM: carica il PDF della scheda cartacea (resta nella sua istanza, non nel
 * repo), lo calibra con i campi e lo elimina. Solo il GM vede questo pannello; il server lo verifica.
 */
export function FormManager({ open, onOpenChange, campaignId }: FormManagerProps) {
  const { template, hasPdf, loading, error, reload } = useFormTemplate(campaignId);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await uploadFormPdf(campaignId, file);
      const dropped = res.droppedFields ?? 0;
      toast.show({
        title: "PDF caricato",
        message: dropped > 0 ? `${dropped} campi tolti: il nuovo PDF ha meno pagine.` : `${res.template?.pages ?? "?"} pagine.`,
        tone: "success",
      });
      await reload();
      setCalibrating(true);
    } catch (err) {
      setMessage(err instanceof ApiRequestError ? err.message : "Caricamento non riuscito.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await deleteForm(campaignId);
      setConfirmDelete(false);
      setCalibrating(false);
      await reload();
      toast.show({ title: "Modulo eliminato", tone: "success" });
    } catch (err) {
      setMessage(err instanceof ApiRequestError ? err.message : "Eliminazione non riuscita.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Modulo del GM">
      <div className="fp-manager">
        {error ? <Banner tone="danger" title="Errore">{error}</Banner> : null}
        {message ? <Banner tone="danger" title="Non riuscito">{message}</Banner> : null}
        {loading && !template ? <p className="t-body">Caricamento…</p> : null}

        {!hasPdf ? (
          <div className="fp-manager__empty">
            <p className="t-body">
              Carica il PDF della scheda che usi al tavolo. Il file resta nella tua istanza di Lanterna: non viene pubblicato né incluso nel codice.
              I giocatori lo vedono con i campi sopra e compilano la loro scheda direttamente su di esso.
            </p>
            <label className="l-btn l-btn--filled l-btn--md">
              {busy ? "Caricamento…" : "Scegli il PDF"}
              <input
                type="file"
                accept="application/pdf,.pdf"
                className="fp-manager__file"
                disabled={busy}
                onChange={(e) => void upload(e.target.files?.[0])}
              />
            </label>
          </div>
        ) : calibrating && template ? (
          <FormCalibrator
            campaignId={campaignId}
            pages={template.pages}
            name={template.name}
            fields={template.fields}
            onSaved={() => {
              setCalibrating(false);
              void reload();
              toast.show({ title: "Campi salvati", tone: "success" });
            }}
          />
        ) : (
          <div className="fp-manager__summary">
            <p className="t-headline">{template?.name ?? "Modulo"}</p>
            <p className="t-body a-muted">
              {template?.pages ?? "?"} pagine · {template?.fields.length ?? 0} campi
            </p>
            <div className="fp-manager__actions">
              <Button size="sm" onClick={() => setCalibrating(true)} disabled={!template}>
                Calibra i campi
              </Button>
              <label className="l-btn l-btn--gray l-btn--sm">
                Sostituisci il PDF
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  className="fp-manager__file"
                  disabled={busy}
                  onChange={(e) => void upload(e.target.files?.[0])}
                />
              </label>
              {confirmDelete ? (
                <Button variant="destructive" size="sm" onClick={() => void remove()} loading={busy}>
                  Conferma eliminazione
                </Button>
              ) : (
                <Button variant="gray" size="sm" onClick={() => setConfirmDelete(true)}>
                  Elimina il modulo
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}
