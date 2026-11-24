import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { formSourceInfo, type FormField, type FormValue } from "@lanterna/shared";
import { openPdf, renderPage } from "./pdfView";
import { sourceLabel } from "./sourceLabels";
import "./forms.css";

/** Larghezza massima di una pagina nel visualizzatore (pixel CSS). */
const MAX_PAGE_WIDTH = 820;

export interface PdfPagesProps {
  pdfUrl: string;
  /** Campi del modulo: ognuno si mostra sopra la pagina, nel rettangolo che il GM ha disegnato. */
  fields: readonly FormField[];
  /** Valore letto dalla scheda per ogni campo (chiave: id del campo). */
  values: Record<string, FormValue | null>;
  /**
   * `fill`: il campo è un input se la sorgente è scrivibile e `canEdit` lo permette.
   * `calibrate`: il campo è solo un riquadro cliccabile (il GM lo sceglie o lo sposta).
   */
  mode: "fill" | "calibrate";
  canEdit?: (field: FormField) => boolean;
  onEdit?: (fieldId: string, value: FormValue) => void;
  selectedId?: string | null;
  onFieldPress?: (fieldId: string) => void;
  /** Livello per pagina, sopra il canvas (es. il GM che disegna un nuovo campo). */
  pageLayer?: (page: number) => ReactNode;
  onError?: (message: string) => void;
}

interface Rendered {
  canvas: HTMLCanvasElement;
  ratio: number;
}

/**
 * Pagine del PDF con i campi sopra. Le posizioni sono percentuali della pagina, quindi il modulo
 * resta allineato a ogni dimensione dello schermo. Il testo dei campi scala con la pagina (cqw).
 */
export function PdfPages({ pdfUrl, fields, values, mode, canEdit, onEdit, selectedId, onFieldPress, pageLayer, onError }: PdfPagesProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<Rendered[]>([]);
  const [width, setWidth] = useState(0);
  // Il genitore passa `onError` nuovo a ogni render: lo teniamo in un ref, senza farlo entrare nelle dipendenze.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // Larghezza disponibile, aggiornata quando cambia la finestra.
  useEffect(() => {
    const measure = () => setWidth(Math.min(MAX_PAGE_WIDTH, hostRef.current?.clientWidth ?? MAX_PAGE_WIDTH));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Apre il PDF una volta per indirizzo.
  useEffect(() => {
    let alive = true;
    const task = openPdf(pdfUrl);
    task.promise
      .then((d) => {
        if (alive) setDoc(d);
      })
      .catch(() => {
        if (alive) onErrorRef.current?.("Non riesco ad aprire il modulo PDF.");
      });
    return () => {
      alive = false;
      void task.destroy();
    };
  }, [pdfUrl]);

  // Disegna tutte le pagine alla larghezza corrente.
  useEffect(() => {
    if (!doc || width <= 0) return;
    let alive = true;
    (async () => {
      const out: Rendered[] = [];
      for (let i = 0; i < doc.numPages; i++) {
        out.push(await renderPage(doc, i, width));
        if (!alive) return;
      }
      if (alive) setPages(out);
    })().catch(() => onErrorRef.current?.("Non riesco a disegnare il modulo PDF."));
    return () => {
      alive = false;
    };
  }, [doc, width]);

  return (
    <div ref={hostRef} className="fp-pages" data-mode={mode}>
      {pages.map((page, index) => (
        <section key={index} className="fp-page" style={{ width, height: width * page.ratio }} aria-label={`Pagina ${index + 1}`}>
          <CanvasHost canvas={page.canvas} />
          {fields
            .filter((f) => f.page === index)
            .map((f) => (
              <FieldBox
                key={f.id}
                field={f}
                ratio={page.ratio}
                mode={mode}
                value={values[f.id] ?? null}
                editable={mode === "fill" && (canEdit?.(f) ?? false) && Boolean(formSourceInfo(f.source)?.writable)}
                onEdit={onEdit}
                selected={selectedId === f.id}
                onPress={onFieldPress}
              />
            ))}
          {pageLayer?.(index)}
        </section>
      ))}
    </div>
  );
}

function CanvasHost({ canvas }: { canvas: HTMLCanvasElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    canvas.className = "fp-canvas";
    host.replaceChildren(canvas);
  }, [canvas]);
  return <div ref={ref} className="fp-canvas-host" />;
}

interface FieldBoxProps {
  field: FormField;
  ratio: number;
  mode: "fill" | "calibrate";
  value: FormValue | null;
  editable: boolean;
  onEdit?: (fieldId: string, value: FormValue) => void;
  selected: boolean;
  onPress?: (fieldId: string) => void;
}

function FieldBox({ field, ratio, mode, value, editable, onEdit, selected, onPress }: FieldBoxProps) {
  const info = formSourceInfo(field.source);
  const style = {
    left: `${field.x * 100}%`,
    top: `${field.y * 100}%`,
    width: `${field.w * 100}%`,
    height: `${field.h * 100}%`,
    // Altezza della casella in percentuale della larghezza della pagina: il testo ci sta dentro.
    fontSize: `${field.h * ratio * 100 * 0.5}cqw`,
  } as const;
  const label = sourceLabel(field.source);

  if (mode === "calibrate") {
    return (
      <button
        type="button"
        className="fp-field fp-field--calibrate"
        data-selected={selected || undefined}
        style={style}
        aria-label={`Campo ${field.id}: ${label}`}
        onClick={() => onPress?.(field.id)}
      >
        <span className="fp-field__name">{field.id}</span>
      </button>
    );
  }

  if (info?.kind === "bool") {
    return (
      <label className="fp-field fp-field--check" style={style} title={label}>
        <input
          type="checkbox"
          aria-label={label}
          checked={value === true}
          disabled={!editable}
          onChange={(e) => onEdit?.(field.id, e.target.checked)}
        />
      </label>
    );
  }

  // Testo e numeri: il valore si invia quando si esce dal campo o si preme Invio (non a ogni tasto).
  const commit = (raw: string) => {
    if (!editable || !onEdit) return;
    if (info?.kind === "number") {
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isInteger(n)) return;
      if (n !== value) onEdit(field.id, n);
      return;
    }
    if (raw !== String(value ?? "")) onEdit(field.id, raw);
  };
  const shown = value === null || value === undefined ? "" : String(value);
  // La chiave include il valore: se la scheda cambia da fuori (un altro utente, annulla) il campo si riallinea.
  const inputKey = `${field.id}:${shown}`;
  const common = {
    defaultValue: shown,
    "aria-label": label,
    title: label,
    readOnly: !editable,
    className: "fp-input",
    onBlur: (e: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => commit(e.currentTarget.value),
  };

  return (
    <div className="fp-field" style={style} data-editable={editable || undefined}>
      {info?.multiline ? (
        <textarea key={inputKey} {...common} />
      ) : (
        <input
          key={inputKey}
          {...common}
          type={info?.kind === "number" ? "number" : "text"}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      )}
    </div>
  );
}
