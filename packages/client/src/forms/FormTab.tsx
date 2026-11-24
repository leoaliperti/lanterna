import { useMemo, useState } from "react";
import { applyFormEdit, formValues, type FormTemplate, type FormValue, type SheetDoc } from "@lanterna/shared";
import { Banner } from "../ui";
import { PdfPages } from "./PdfPages";
import { formPdfUrl } from "./formApi";

export interface FormTabProps {
  campaignId: string;
  doc: SheetDoc;
  template: FormTemplate;
  /** Chi può scrivere la scheda: GM o proprietario del personaggio. Il server lo verifica comunque. */
  canEdit: boolean;
  change: (fn: (d: SheetDoc) => SheetDoc) => void;
}

/**
 * La scheda compilata sopra il PDF del GM. Ogni modifica passa da `applyFormEdit` (la stessa
 * validazione della scheda) e poi dal salvataggio automatico della scheda.
 */
export function FormTab({ campaignId, doc, template, canEdit, change }: FormTabProps) {
  const [error, setError] = useState<string | null>(null);
  const values = useMemo(() => formValues(doc, template), [doc, template]);

  function onEdit(fieldId: string, value: FormValue) {
    try {
      applyFormEdit(doc, template, fieldId, value);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Valore non valido");
      return;
    }
    setError(null);
    change((d) => applyFormEdit(d, template, fieldId, value));
  }

  return (
    <div className="fp-tab">
      {error ? <Banner tone="danger" title="Non salvato">{error}</Banner> : null}
      <PdfPages
        pdfUrl={formPdfUrl(campaignId)}
        fields={template.fields}
        values={values}
        mode="fill"
        canEdit={() => canEdit}
        onEdit={onEdit}
        onError={setError}
      />
    </div>
  );
}
