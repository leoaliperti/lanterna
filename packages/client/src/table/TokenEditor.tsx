import { useEffect, useMemo, useState } from "react";
import { Library, Trash2 } from "lucide-react";
import { EffectList } from "../combat/EffectList";
import type { CampaignView, SceneView, TokenShape } from "@lanterna/shared";
import { userErrorMessage, uploadErrorMessage, uploadImage } from "../api/client";
import { createLibraryItem } from "../library/libraryApi";
import { libraryInputFromDraft } from "../library/libraryLogic";
import { LIBRARY_CHANGED } from "../library/LibraryPanel";
import { Alert, Button, Menu, Picker, SegmentedControl, Sheet, Stepper, TextArea, TextField, Toggle, useToast } from "../ui";
import { assetUrl } from "../realtime/urls";
import { useCommands } from "../realtime/RealtimeProvider";
import { CONDITION_LIST, ConditionIcon } from "./conditions";
import { ImagePicker } from "./ImagePicker";
import { NumberField } from "./NumberField";
import { permissionsFor } from "./permissions";
import { createCommand, diffDraft, draftOfToken, emptyDraft, hasErrors, spawnPoint, validateDraft, type TokenDraft } from "./tokenDraft";

export interface TokenEditorProps {
  view: CampaignView;
  /** Scena in cui si crea il token. */
  scene: SceneView | null;
  /** `null` = nuovo token. */
  tokenId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Il GM vuole aggiungere un effetto temporaneo al token (chi apre l'editor lo chiude e apre il modulo dell'effetto). */
  onAddEffect?: (tokenId: string) => void;
}

const NO_OWNER = "__none__";

const SHAPE_OPTIONS = [
  { value: "circle", label: "Cerchio" },
  { value: "square", label: "Quadrato" },
  { value: "diamond", label: "Rombo" },
  { value: "hexagon", label: "Esagono" },
  { value: "triangle", label: "Triangolo" }
] as const;

const KIND_OPTIONS = [
  { value: "pc", label: "Personaggio" },
  { value: "monster", label: "Mostro" },
  { value: "object", label: "Oggetto" }
] as const;

/**
 * Scheda del token. Il GM modifica tutto; il giocatore proprietario solo le condizioni (e vede la
 * propria vita se il server gliel'ha inviata). Il server rifiuta comunque cio' che non spetta.
 */
export function TokenEditor({ view, scene, tokenId, open, onOpenChange, onAddEffect }: TokenEditorProps) {
  const { run } = useCommands();
  const toast = useToast();
  const token = useMemo(() => (tokenId ? (view.tokens.find((t) => t.id === tokenId) ?? null) : null), [view.tokens, tokenId]);
  const perms = permissionsFor(view);
  const creating = tokenId === null;
  const fields = token ? perms.canEditFields(token) : { all: perms.isGm, conditions: perms.isGm };
  const readOnlyFields = !fields.all;

  const [draft, setDraft] = useState<TokenDraft>(() => (token ? draftOfToken(token) : emptyDraft()));
  // Un oggetto non è una creatura: niente vita, vista e condizioni (vedi `creature` nel form).
  const creature = draft.kind !== "object";
  const [file, setFile] = useState<File | null>(null);
  const [imageRemoved, setImageRemoved] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Si riparte dal token attuale solo all'apertura: gli aggiornamenti in arrivo non cancellano cio' che si sta scrivendo.
  useEffect(() => {
    if (!open) return;
    setDraft(token ? draftOfToken(token) : emptyDraft());
    setFile(null);
    setImageRemoved(false);
    setUploadError(null);
    setSubmitted(false);
    setBusy(false);
  }, [open, tokenId]); // volutamente senza `token`

  // Il token e' sparito (eliminato o nascosto mentre l'editor e' aperto): si chiude.
  useEffect(() => {
    if (open && !creating && !token) onOpenChange(false);
  }, [open, creating, token, onOpenChange]);

  const errors = validateDraft(draft);
  const set = <K extends keyof TokenDraft>(key: K, value: TokenDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const players = view.members.filter((m) => m.role === "player");

  function toggleCondition(id: string, name: string) {
    setDraft((d) => ({
      ...d,
      conditions: d.conditions.some((c) => c.id === id)
        ? d.conditions.filter((c) => c.id !== id)
        : [...d.conditions, id === "exhaustion" ? { id, name, level: 1 } : { id, name }]
    }));
  }

  /** Esaurimento: livello 1-6 (6 = morte, come da regole); il livello 0 lo toglie. */
  function setExhaustion(level: number) {
    setDraft((d) => ({ ...d, conditions: d.conditions.map((c) => (c.id === "exhaustion" ? { ...c, level } : c)) }));
  }

  /** "Salva nella libreria": un modello dal token com'e' ora nel modulo (immagine: l'ultima salvata). */
  async function saveToLibrary(global: boolean) {
    if (hasErrors(errors) || !token) {
      setSubmitted(true);
      return;
    }
    try {
      const image = imageRemoved ? null : (token.imageUrl ?? null);
      await createLibraryItem(libraryInputFromDraft(draft, image, global ? { kind: "global" } : { kind: "campaign", campaignId: view.campaignId }));
      window.dispatchEvent(new Event(LIBRARY_CHANGED));
      toast.show({ title: `${draft.name.trim()} salvato nella libreria`, tone: "success" });
    } catch (err) {
      toast.show({ title: "Non riesco a salvare nella libreria", message: userErrorMessage(err), tone: "danger" });
    }
  }

  async function submit() {
    setSubmitted(true);
    if (fields.all && hasErrors(errors)) return;
    if (creating && !scene) return;
    setBusy(true);
    setUploadError(null);
    try {
      let imageUrl: string | null = imageRemoved ? null : (token?.imageUrl ?? null);
      if (file && fields.all) {
        try {
          imageUrl = (await uploadImage("token", file)).url;
        } catch (err) {
          setUploadError(uploadErrorMessage(err));
          return;
        }
      }
      if (creating) {
        const at = spawnPoint(scene!, draft.size, view.tokens.filter((t) => t.sceneId === scene!.id));
        if (await run(createCommand(crypto.randomUUID(), scene!.id, draft, imageUrl, at.x, at.y))) onOpenChange(false);
        return;
      }
      const patch = diffDraft(token!, draft, imageUrl, !fields.all);
      if (Object.keys(patch).length === 0) {
        onOpenChange(false);
        return;
      }
      if (await run({ type: "token.update", tokenId: token!.id, patch })) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  const title = creating ? "Nuovo token" : readOnlyFields ? `Condizioni di ${token?.name ?? ""}` : "Modifica token";
  const currentImage = imageRemoved ? undefined : assetUrl(draft.imageUrl);
  const err = (e: string | null) => (submitted ? e : null);
  const unit = scene?.scale.unit ?? "unita'";

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title}>
      <form
        className="a-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {fields.all ? (
          <>
            <TextField label="Nome" value={draft.name} onChange={(e) => set("name", e.target.value)} error={err(errors.name) ?? undefined} autoComplete="off" />
            <div className="a-field-group">
              <span className="t-footnote a-muted">Tipo</span>
              <SegmentedControl aria-label="Tipo di token" options={[...KIND_OPTIONS]} value={draft.kind} onValueChange={(v) => set("kind", v)} />
            </div>
            <div className="a-stepper-row">
              <span className="t-body">Dimensione: {draft.size === 1 ? "1 cella" : `${draft.size} celle`}</span>
              <Stepper label="dimensione" value={draft.size} onValueChange={(v) => set("size", v)} min={0.5} max={12} step={0.5} />
            </div>
            <Picker label="Forma" options={[...SHAPE_OPTIONS]} value={draft.shape} onValueChange={(v) => set("shape", v as TokenShape)} />
            <TextField
              label="Numero sul token"
              value={draft.number}
              onChange={(e) => set("number", e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
              helper="Vuoto = nessuno. Lo vedono tutti: utile per distinguere i personaggi in battaglia."
              inputMode="numeric"
              autoComplete="off"
            />
            <ImagePicker
              label="Immagine"
              file={file}
              onFileChange={(f) => {
                setFile(f);
                if (f) setImageRemoved(false);
              }}
              currentUrl={currentImage}
              onClearCurrent={() => setImageRemoved(true)}
              error={uploadError}
              disabled={busy}
              helper="Senza immagine il token ha un colore in base al tipo."
            />
            <div className="a-field-group">
              <span className="t-footnote a-muted">Proprietario</span>
              <Picker
                label="Proprietario"
                options={[{ value: NO_OWNER, label: "Nessuno" }, ...players.map((m) => ({ value: m.userId, label: m.displayName }))]}
                value={draft.ownerUserId ?? NO_OWNER}
                onValueChange={(v) => set("ownerUserId", v === NO_OWNER ? null : v)}
              />
              <p className="t-caption1 a-muted">Il proprietario sposta il token e ne vede la barra della vita.</p>
            </div>
            <TextField
              label="Fazione"
              value={draft.faction}
              onChange={(e) => set("faction", e.target.value)}
              error={err(errors.faction) ?? undefined}
              helper="Serve a selezionare i token insieme (es. Eroi, Orda). Solo tu la vedi."
              autoComplete="off"
              list="fazioni-note"
            />
            <datalist id="fazioni-note">
              {[...new Set(view.tokens.flatMap((t) => (t.faction ? [t.faction] : [])))].map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
            <Toggle label="Nascosto ai giocatori" checked={draft.hidden} onCheckedChange={(v) => set("hidden", v)} />
            {creature ? <Toggle label="Vista e luce (aiuto visivo)" checked={draft.hasVision} onCheckedChange={(v) => set("hasVision", v)} /> : null}
            {creature && draft.hasVision ? (
              <>
                <div className="a-form__pair">
                  <NumberField label={`Raggio di vista (${unit})`} value={draft.visionRange} onValueChange={(v) => set("visionRange", v)} min={0} helper="Vuoto = illimitato." />
                  <NumberField label={`Scurovisione (${unit})`} value={draft.darkvision} onValueChange={(v) => set("darkvision", v)} min={0} />
                  <NumberField label={`Luce intensa (${unit})`} value={draft.lightBright} onValueChange={(v) => set("lightBright", v)} min={0} />
                  <NumberField label={`Luce fioca oltre (${unit})`} value={draft.lightDim} onValueChange={(v) => set("lightDim", v)} min={0} />
                </div>
                {err(errors.vision) ? (
                  <p className="t-footnote a-picker__error" role="alert">
                    {errors.vision}
                  </p>
                ) : null}
                <p className="t-caption1 a-muted">Mostra cosa vede il token (muri compresi) come contorno tratteggiato. Serve solo da aiuto: non scopre mai la nebbia.</p>
              </>
            ) : null}
            {creature ? <Toggle label="Barra della vita" checked={draft.hasHealth} onCheckedChange={(v) => set("hasHealth", v)} /> : null}
            {creature && draft.hasHealth ? (
              <>
                <div className="a-form__triple">
                  <NumberField label="Attuali" value={draft.current} onValueChange={(v) => set("current", v)} min={0} error={err(errors.current)} />
                  <NumberField label="Massimi" value={draft.max} onValueChange={(v) => set("max", v)} min={0} error={err(errors.max)} />
                  <NumberField label="Temporanei" value={draft.temp} onValueChange={(v) => set("temp", v)} min={0} error={err(errors.temp)} />
                </div>
                {err(errors.health) ? (
                  <p className="t-footnote a-picker__error" role="alert">
                    {errors.health}
                  </p>
                ) : null}
              </>
            ) : null}
          </>
        ) : token?.health ? (
          <p className="t-body">
            Punti ferita: {token.health.current}/{token.health.max}
            {token.health.temp > 0 ? ` (+${token.health.temp} temporanei)` : ""}
          </p>
        ) : null}

        {creature ? (
        <fieldset className="a-conditions" disabled={!fields.conditions}>
          <legend className="t-footnote a-muted">Condizioni</legend>
          <div className="a-conditions__grid">
            {CONDITION_LIST.map((c) => {
              const on = draft.conditions.some((x) => x.id === c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  className="a-chip"
                  aria-pressed={on}
                  onClick={() => toggleCondition(c.id, c.name)}
                >
                  <ConditionIcon id={c.id} size={16} />
                  <span>{c.name}{on && c.id === "exhaustion" ? ` ${draft.conditions.find((x) => x.id === "exhaustion")?.level ?? 1}` : ""}</span>
                </button>
              );
            })}
          </div>
          {draft.conditions.some((c) => c.id === "exhaustion") ? (
            <Stepper
              label="Livello di esaurimento"
              value={draft.conditions.find((c) => c.id === "exhaustion")?.level ?? 1}
              onValueChange={setExhaustion}
              min={1}
              max={6}
              step={1}
            />
          ) : null}
        </fieldset>
        ) : null}

        {token ? <EffectList token={token} view={view} canEdit={fields.all} onAdd={() => onAddEffect?.(token.id)} /> : null}

        {fields.all && perms.canSeeGmNotes ? (
          <TextArea label="Note del GM (private)" value={draft.gmNotes} onChange={(e) => set("gmNotes", e.target.value)} helper="Solo tu le vedi: il server non le invia ai giocatori." />
        ) : null}

        <div className="a-form__actions">
          {!creating && fields.all ? (
            <Button variant="destructive" icon={<Trash2 size={16} />} onClick={() => setConfirmDelete(true)} disabled={busy}>
              Elimina
            </Button>
          ) : null}
          {!creating && fields.all ? (
            <Menu
              label="Salva nella libreria"
              placement="top-start"
              items={[
                { id: "campaign", label: "Libreria della campagna", icon: <Library size={18} />, onSelect: () => void saveToLibrary(false) },
                { id: "global", label: "Libreria globale", icon: <Library size={18} />, onSelect: () => void saveToLibrary(true) }
              ]}
              trigger={
                <Button variant="gray" icon={<Library size={16} />} disabled={busy}>
                  Salva nella libreria
                </Button>
              }
            />
          ) : null}
          <span className="a-form__spacer" />
          <Button variant="gray" onClick={() => onOpenChange(false)} disabled={busy}>
            Annulla
          </Button>
          <Button type="submit" loading={busy}>
            {creating ? "Aggiungi" : "Salva"}
          </Button>
        </div>
      </form>
      <Alert
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Eliminare il token?"
        message="Puoi annullare subito dopo con Annulla (Cmd/Ctrl+Z)."
        actions={[
          { label: "Annulla", role: "cancel" },
          {
            label: "Elimina",
            role: "destructive",
            onPress: () => {
              if (!token) return;
              void run({ type: "token.delete", tokenId: token.id }).then((ok) => ok && onOpenChange(false));
            }
          }
        ]}
      />
    </Sheet>
  );
}
