import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, Download, FileArchive, Upload } from "lucide-react";
import type { CampaignSummary, ImportPreview, ImportResult, PublicUser } from "@lanterna/shared";
import { Badge, Banner, Button, IconButton, List, ListRow, NavigationBar, Picker, ProgressView, Spinner, TextField, Toggle } from "../ui";
import { archiveErrorMessage, downloadExport, importArchive, listAllCampaigns, previewArchive } from "../api/archive";
import { listUsers, userErrorMessage } from "../api/client";
import { navigate } from "../router/hashRouter";
import { formatBytes } from "../table/upload";
import { NO_USER, buildOptions, suggestMapping, summaryRows, takenUsers } from "./backupLogic";
import "./app.css";

type Stage =
  | { name: "idle" }
  /** Il file sta andando al server per essere controllato. */
  | { name: "checking"; file: File; progress: number | null }
  | { name: "preview"; file: File; preview: ImportPreview }
  | { name: "importing"; file: File; preview: ImportPreview; progress: number | null }
  | { name: "done"; result: ImportResult };

/**
 * Backup e importazione (solo admin: guardia in App, ma la sicurezza vera e' sul server).
 * Esporta una campagna in un archivio .zip e ne crea una NUOVA da un archivio, con anteprima del contenuto
 * e scelta degli utenti a cui associare i giocatori. L'archivio non contiene account ne' password.
 */
export function BackupScreen() {
  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [withChat, setWithChat] = useState(false);

  const [stage, setStage] = useState<Stage>({ name: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [importChat, setImportChat] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const list = await listAllCampaigns();
      setCampaigns(list);
      setSelected((s) => s ?? list[0]?.id ?? null);
    } catch (err) {
      setLoadError(userErrorMessage(err));
      return;
    }
    // Gli utenti servono solo all'associazione dei giocatori: senza, l'esportazione resta usabile.
    try {
      setUsers(await listUsers());
    } catch {
      setUsers([]);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => abort.current?.abort();
  }, [load]);

  const players = users.filter((u) => u.role === "player");

  async function choose(file: File | undefined) {
    if (!file) return;
    setError(null);
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setStage({ name: "checking", file, progress: 0 });
    try {
      const preview = await previewArchive(file, (progress) => setStage((s) => (s.name === "checking" ? { ...s, progress } : s)), controller.signal);
      setName(preview.campaignName);
      setImportChat(preview.includesChat);
      setMapping(suggestMapping(preview.members, players));
      setStage({ name: "preview", file, preview });
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(archiveErrorMessage(err));
      setStage({ name: "idle" });
    } finally {
      if (input.current) input.current.value = "";
    }
  }

  async function confirm() {
    if (stage.name !== "preview") return;
    const { file, preview } = stage;
    setError(null);
    const controller = new AbortController();
    abort.current = controller;
    setStage({ name: "importing", file, preview, progress: 0 });
    try {
      const result = await importArchive(
        file,
        buildOptions({ name, archiveName: preview.campaignName, includeChat: importChat && preview.includesChat, members: preview.members, mapping }),
        (progress) => setStage((s) => (s.name === "importing" ? { ...s, progress } : s)),
        controller.signal
      );
      setStage({ name: "done", result });
      void load();
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(archiveErrorMessage(err));
      // L'anteprima resta: si puo' correggere la mappatura e riprovare.
      setStage({ name: "preview", file, preview });
    }
  }

  const reset = () => {
    abort.current?.abort();
    setStage({ name: "idle" });
    setError(null);
  };

  return (
    <div className="a-page a-enter">
      <NavigationBar title="Backup e importazione" leading={<IconButton label="Torna al tavolo" icon={<ChevronLeft size={22} />} onClick={() => navigate("/")} />} />
      <main className="a-page__content" aria-label="Backup e importazione">
        <p className="t-subhead a-muted a-page__intro">
          Esporta una campagna in un archivio da conservare o spostare, oppure creane una nuova da un archivio. L&apos;importazione non sovrascrive mai una
          campagna esistente. Account e password non sono mai inclusi: i giocatori compaiono solo con nome e ruolo.
        </p>

        {loadError ? (
          <Banner tone="danger" title="Non riesco a caricare le campagne">
            {loadError}
          </Banner>
        ) : null}

        <section className="a-backup" aria-labelledby="exp-title">
          <h2 id="exp-title" className="t-title3">
            Esporta
          </h2>
          {campaigns === null && !loadError ? (
            <Spinner label="Caricamento delle campagne" />
          ) : campaigns && campaigns.length === 0 ? (
            <p className="t-subhead a-muted">Non ci sono ancora campagne da esportare.</p>
          ) : campaigns ? (
            <>
              <List aria-label="Campagne">
                {campaigns.map((c) => (
                  <ListRow
                    key={c.id}
                    title={c.name}
                    selected={c.id === selected}
                    trailing={
                      <span className="a-row-actions">
                        {c.id === selected ? <Badge tone="tint">Scelta</Badge> : null}
                        <Button size="sm" variant="gray" onClick={() => navigate(`/?campaign=${encodeURIComponent(c.id)}`)} aria-label={`Apri ${c.name}`}>
                          Apri
                        </Button>
                      </span>
                    }
                    onPress={() => setSelected(c.id)}
                  />
                ))}
              </List>
              <Toggle label="Includi chat e tiri (anche whisper e tiri segreti)" checked={withChat} onCheckedChange={setWithChat} />
              <Button icon={<Download size={16} />} disabled={!selected} onClick={() => selected && downloadExport(selected, withChat)}>
                Scarica archivio (.zip)
              </Button>
            </>
          ) : null}
        </section>

        <section className="a-backup" aria-labelledby="imp-title">
          <h2 id="imp-title" className="t-title3">
            Importa
          </h2>
          {error ? (
            <Banner tone="danger" title="Importazione non riuscita" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          ) : null}

          {stage.name === "idle" || stage.name === "checking" ? (
            <>
              <input
                ref={input}
                type="file"
                accept=".zip,application/zip"
                className="l-sr-only"
                aria-label="Archivio da importare (.zip)"
                onChange={(e) => void choose(e.target.files?.[0])}
                disabled={stage.name === "checking"}
              />
              <Button variant="gray" icon={<FileArchive size={16} />} loading={stage.name === "checking"} onClick={() => input.current?.click()}>
                Scegli un archivio…
              </Button>
              {stage.name === "checking" ? (
                <ProgressView label="Controllo dell'archivio" value={stage.progress === null ? undefined : stage.progress} />
              ) : (
                <p className="t-footnote a-muted">Prima di creare qualcosa vedrai cosa contiene l&apos;archivio.</p>
              )}
              {stage.name === "checking" ? (
                <p className="t-footnote a-muted" role="status">
                  {stage.progress === null ? "Il server sta controllando l'archivio…" : `Caricamento di ${stage.file.name}…`}
                </p>
              ) : null}
            </>
          ) : null}

          {stage.name === "preview" || stage.name === "importing" ? (
            <PreviewForm
              preview={stage.preview}
              fileName={stage.file.name}
              busy={stage.name === "importing"}
              progress={stage.name === "importing" ? stage.progress : undefined}
              name={name}
              onName={setName}
              importChat={importChat}
              onImportChat={setImportChat}
              players={players}
              mapping={mapping}
              onMapping={(ref, id) => setMapping((m) => ({ ...m, [ref]: id }))}
              onConfirm={() => void confirm()}
              onCancel={reset}
            />
          ) : null}

          {stage.name === "done" ? (
            <div className="a-backup__done">
              <Banner tone="success" title="Campagna importata">
                {`"${stage.result.campaign.name}" è stata creata come nuova campagna.`}
                {stage.result.warnings.length > 0 ? ` ${stage.result.warnings.join(" ")}` : ""}
              </Banner>
              <div className="a-form__actions">
                <Button variant="gray" onClick={reset}>
                  Importa un altro archivio
                </Button>
                <span className="a-form__spacer" />
                <Button icon={<Upload size={16} />} onClick={() => navigate(`/?campaign=${encodeURIComponent(stage.result.campaign.id)}`)}>
                  Apri la campagna
                </Button>
              </div>
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}

interface PreviewFormProps {
  preview: ImportPreview;
  fileName: string;
  busy: boolean;
  /** Solo durante l'importazione: 0..1 durante il caricamento, `null` mentre il server elabora. */
  progress?: number | null;
  name: string;
  onName: (v: string) => void;
  importChat: boolean;
  onImportChat: (v: boolean) => void;
  players: PublicUser[];
  mapping: Record<string, string>;
  onMapping: (ref: string, userId: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Cosa c'e' nell'archivio, a chi associare i giocatori, poi la conferma. */
function PreviewForm({ preview, fileName, busy, progress, name, onName, importChat, onImportChat, players, mapping, onMapping, onConfirm, onCancel }: PreviewFormProps) {
  const rows = summaryRows(preview.counts, preview.includesChat);
  const date = new Date(preview.exportedAt);
  const exported = Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" });
  const gm = preview.members.filter((m) => m.role === "admin");
  const playerMembers = preview.members.filter((m) => m.role === "player");

  return (
    <form
      className="a-form a-backup__form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) onConfirm();
      }}
    >
      <List header={`Contenuto di ${fileName}`} footer={`${exported ? `Esportato il ${exported}. ` : ""}Versione ${preview.appVersion}. ${formatBytes(preview.unpackedBytes)} una volta aperto.`}>
        {rows.length === 0 ? <ListRow title="Campagna vuota" /> : null}
        {rows.map((r) => (
          <ListRow key={r.label} title={r.label} trailing={<span className="t-body">{r.value}</span>} />
        ))}
      </List>

      {preview.warnings.length > 0 ? (
        <Banner tone="warning" title="Avvisi dell'esportazione">
          {preview.warnings.join(" ")}
        </Banner>
      ) : null}

      <TextField label="Nome della nuova campagna" value={name} onChange={(e) => onName(e.target.value)} maxLength={64} autoComplete="off" disabled={busy} />

      {gm.length > 0 || playerMembers.length > 0 ? (
        <fieldset className="a-backup__members" disabled={busy}>
          <legend className="t-headline">Membri</legend>
          <p className="t-footnote a-muted">
            L&apos;archivio contiene solo nomi e ruoli. Il GM sei tu. Associa ogni giocatore a un utente esistente: token, schede e nebbia personale passano a lui. Chi non
            associ perde solo la proprietà.
          </p>
          {playerMembers.length === 0 ? <p className="t-subhead a-muted">Nessun giocatore nell&apos;archivio.</p> : null}
          {playerMembers.map((m) => {
            const taken = takenUsers(mapping, m.ref);
            return (
              <div key={m.ref} className="a-backup__member">
                <span className="t-body">{m.name}</span>
                <Picker
                  label={`Utente per ${m.name}`}
                  value={mapping[m.ref] ?? NO_USER}
                  onValueChange={(v) => onMapping(m.ref, v)}
                  options={[{ value: NO_USER, label: "Non associare" }, ...players.filter((u) => !taken.has(u.id)).map((u) => ({ value: u.id, label: u.name }))]}
                />
              </div>
            );
          })}
        </fieldset>
      ) : null}

      {preview.includesChat ? <Toggle label={`Importa chat e tiri (${preview.counts.chat} voci)`} checked={importChat} onCheckedChange={onImportChat} disabled={busy} /> : null}

      {busy ? (
        <>
          <ProgressView label="Importazione" value={progress === null || progress === undefined ? undefined : progress} />
          <p className="t-footnote a-muted" role="status">
            {progress === null || progress === undefined || progress >= 1 ? "Il server sta creando la campagna…" : "Caricamento dell'archivio…"}
          </p>
        </>
      ) : null}

      <div className="a-form__actions">
        <Button variant="gray" onClick={onCancel} disabled={busy && progress === null}>
          Annulla
        </Button>
        <span className="a-form__spacer" />
        <Button type="submit" loading={busy} disabled={name.trim() === ""}>
          Importa campagna
        </Button>
      </div>
    </form>
  );
}
