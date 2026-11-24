import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { FORM_SOURCE_IDS, type FormField } from "@lanterna/shared";
import { Banner, Button, Picker, TextField } from "../ui";
import { PdfPages } from "./PdfPages";
import { saveForm, formPdfUrl } from "./formApi";
import { sourceLabel } from "./sourceLabels";

/** Un campo più piccolo di questo (frazione della pagina) è un clic, non un rettangolo. */
const MIN_SIDE = 0.01;
const ID_PATTERN = /^[a-z0-9_.-]{1,60}$/;

interface Drag {
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface FormCalibratorProps {
  campaignId: string;
  pages: number;
  name: string;
  fields: readonly FormField[];
  onSaved: (name: string, fields: FormField[]) => void;
}

/**
 * Calibrazione del modulo (solo GM): si trascina un rettangolo sulla pagina per creare un campo,
 * poi si sceglie il dato della scheda che il campo mostra o modifica. Le posizioni sono normalizzate,
 * quindi restano giuste a ogni dimensione dello schermo.
 */
export function FormCalibrator({ campaignId, pages, name: initialName, fields: initialFields, onSaved }: FormCalibratorProps) {
  const [name, setName] = useState(initialName);
  const [fields, setFields] = useState<FormField[]>([...initialFields]);
  const [selected, setSelected] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = fields.find((f) => f.id === selected) ?? null;
  const sourceOptions = [...FORM_SOURCE_IDS]
    .map((id) => ({ value: id, label: sourceLabel(id) }))
    .sort((a, b) => a.label.localeCompare(b.label, "it"));

  function nextId(): string {
    for (let n = 1; ; n++) {
      const id = `campo-${n}`;
      if (!fields.some((f) => f.id === id)) return id;
    }
  }

  function addField(page: number, x: number, y: number, w: number, h: number) {
    const id = nextId();
    const field: FormField = { id, page, x, y, w, h, source: "name" };
    setFields((list) => [...list, field]);
    setSelected(id);
  }

  function patchSelected(patch: Partial<FormField>) {
    if (!current) return;
    setFields((list) => list.map((f) => (f.id === current.id ? { ...f, ...patch } : f)));
  }

  function removeSelected() {
    if (!current) return;
    setFields((list) => list.filter((f) => f.id !== current.id));
    setSelected(null);
  }

  // Disegno: il puntatore è catturato dalla pagina, le coordinate sono frazioni del suo rettangolo.
  function pointerPos(e: ReactPointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  }

  function onDown(page: number, e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pointerPos(e);
    setDrag({ page, x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  }

  function onMove(page: number, e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag || drag.page !== page) return;
    const p = pointerPos(e);
    setDrag({ ...drag, x1: p.x, y1: p.y });
  }

  function onUp(page: number) {
    if (!drag || drag.page !== page) return;
    const x = Math.min(drag.x0, drag.x1);
    const y = Math.min(drag.y0, drag.y1);
    const w = Math.abs(drag.x1 - drag.x0);
    const h = Math.abs(drag.y1 - drag.y0);
    setDrag(null);
    if (w >= MIN_SIDE && h >= MIN_SIDE) {
      addField(page, x, y, w, h);
      setDrawing(false);
    }
  }

  const problems = validate(fields);

  async function save() {
    if (problems.length > 0) {
      setError(problems[0] ?? null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await saveForm(campaignId, { name, fields });
      onSaved(saved.template?.name ?? name, saved.template?.fields ?? fields);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Salvataggio non riuscito.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fp-calibrator">
      <div className="fp-calibrator__bar">
        <TextField label="Nome del modulo" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        <Button variant={drawing ? "tinted" : "gray"} size="sm" onClick={() => setDrawing((d) => !d)} aria-pressed={drawing}>
          {drawing ? "Annulla il disegno" : "Disegna un campo"}
        </Button>
        <Button size="sm" onClick={() => void save()} loading={busy}>
          Salva i campi ({fields.length})
        </Button>
      </div>
      {drawing ? <p className="t-footnote">Trascina un rettangolo sulla pagina, nel punto dove deve stare il dato.</p> : null}
      {error ? <Banner tone="danger" title="Non salvato">{error}</Banner> : null}

      {current ? (
        <div className="fp-calibrator__editor">
          <TextField
            label="Identificativo del campo"
            value={current.id}
            maxLength={60}
            autoComplete="off"
            onChange={(e) => patchSelected({ id: e.target.value })}
            helper="Solo lettere minuscole, cifre, punto, trattino o underscore."
            error={ID_PATTERN.test(current.id) ? undefined : "Identificativo non valido."}
          />
          <Picker
            label="Dato della scheda"
            showLabel
            options={sourceOptions}
            value={current.source}
            onValueChange={(source) => patchSelected({ source })}
          />
          <Button variant="destructive" size="sm" onClick={removeSelected}>
            Rimuovi questo campo
          </Button>
        </div>
      ) : (
        <p className="t-footnote">Clicca un campo sulla pagina per modificarlo.</p>
      )}

      <PdfPages
        pdfUrl={formPdfUrl(campaignId)}
        fields={fields}
        values={{}}
        mode="calibrate"
        selectedId={selected}
        onFieldPress={(id) => {
          setSelected(id);
          setDrawing(false);
        }}
        onError={setError}
        pageLayer={(page) =>
          drawing ? (
            <div
              className="fp-draw"
              onPointerDown={(e) => onDown(page, e)}
              onPointerMove={(e) => onMove(page, e)}
              onPointerUp={() => onUp(page)}
              onPointerCancel={() => setDrag(null)}
            >
              {drag && drag.page === page ? (
                <div
                  className="fp-draw__rect"
                  style={{
                    left: `${Math.min(drag.x0, drag.x1) * 100}%`,
                    top: `${Math.min(drag.y0, drag.y1) * 100}%`,
                    width: `${Math.abs(drag.x1 - drag.x0) * 100}%`,
                    height: `${Math.abs(drag.y1 - drag.y0) * 100}%`,
                  }}
                />
              ) : null}
            </div>
          ) : null
        }
      />
      <span className="a-muted t-caption1">{pages} pagine</span>
    </div>
  );
}

/** Controlli locali prima del salvataggio (il server ricontrolla comunque tutto). */
export function validate(fields: readonly FormField[]): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const f of fields) {
    if (!ID_PATTERN.test(f.id)) out.push(`Identificativo non valido: ${f.id}`);
    if (ids.has(f.id)) out.push(`Identificativo duplicato: ${f.id}`);
    ids.add(f.id);
  }
  return out;
}
