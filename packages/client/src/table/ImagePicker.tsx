import { useEffect, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { Button } from "../ui";
import { ACCEPT_ATTR, formatBytes, validateImageFile } from "./upload";

export interface ImagePickerProps {
  label: string;
  file: File | null;
  onFileChange: (file: File | null) => void;
  /** Immagine gia' presente (URL pubblico), mostrata finche' non si sceglie un altro file. */
  currentUrl?: string;
  onClearCurrent?: () => void;
  error?: string | null;
  disabled?: boolean;
  helper?: string;
}

/**
 * Sceglie un'immagine e ne mostra l'anteprima locale. Non carica nulla: chi lo usa invia il file
 * solo alla conferma (cosi' un annullamento non lascia file orfani sul server).
 */
export function ImagePicker({ label, file, onFileChange, currentUrl, onClearCurrent, error, disabled, helper }: ImagePickerProps) {
  const input = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== "function") {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const shown = preview ?? currentUrl ?? null;
  const message = localError ?? error ?? null;

  return (
    <div className="a-picker">
      <p className="a-picker__label t-footnote a-muted">{label}</p>
      <div className="a-picker__row">
        <div className="a-picker__preview" aria-hidden={shown ? undefined : true}>
          {shown ? <img src={shown} alt={`Anteprima: ${label}`} /> : <ImagePlus size={24} aria-hidden="true" />}
        </div>
        <div className="a-picker__actions">
          <input
            ref={input}
            type="file"
            accept={ACCEPT_ATTR}
            className="l-sr-only"
            tabIndex={-1}
            aria-label={`${label}: scegli file`}
            disabled={disabled}
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              e.target.value = "";
              if (!f) return;
              const check = validateImageFile(f);
              if (!check.ok) {
                setLocalError(check.message);
                return;
              }
              setLocalError(null);
              onFileChange(f);
            }}
          />
          <Button variant="gray" size="sm" icon={<ImagePlus size={16} />} disabled={disabled} onClick={() => input.current?.click()}>
            {shown ? "Cambia immagine" : "Scegli immagine"}
          </Button>
          {file ? <p className="t-caption1 a-muted">{file.name} ({formatBytes(file.size)})</p> : null}
          {file || (currentUrl && onClearCurrent) ? (
            <Button
              variant="plain"
              size="sm"
              icon={<X size={16} />}
              disabled={disabled}
              onClick={() => {
                setLocalError(null);
                if (file) onFileChange(null);
                else onClearCurrent?.();
              }}
            >
              Rimuovi
            </Button>
          ) : null}
        </div>
      </div>
      {message ? (
        <p className="t-footnote a-picker__error" role="alert">
          {message}
        </p>
      ) : helper ? (
        <p className="t-caption1 a-muted">{helper}</p>
      ) : null}
    </div>
  );
}
