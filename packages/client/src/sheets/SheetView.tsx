import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CloudOff, LoaderCircle } from "lucide-react";
import { blankDoc, deriveDoc, type SheetDoc, type SheetRecord } from "@lanterna/shared";
import { Banner, Button, SearchField, Spinner, Tabs, useToast, type TabItem } from "../ui";
import { useRealtimeState } from "../realtime/RealtimeProvider";
import { AbilitiesSection, SkillsSection } from "./AbilitiesSection";
import { CombatSection } from "./CombatSection";
import { EditSection } from "./EditSection";
import type { SectionProps } from "./fields";
import { InventorySection } from "./InventorySection";
import { NotesSection } from "./NotesSection";
import { SpellsSection } from "./SpellsSection";
import { patchSheet } from "./sheetLogic";
import { deleteSheet, getSheet, isConflict, saveSheet, sheetErrorMessage } from "./sheetsApi";
import { useSheets } from "./SheetsProvider";
import { useSheetRoll } from "./useSheetRoll";

const AUTOSAVE_MS = 700;

type Status = "idle" | "saving" | "saved" | "error" | "conflict";

export interface SheetViewProps {
  sheetId: string;
}

/**
 * Una scheda aperta: carica il record, tiene la bozza e la salva da sola (con la versione letta: se qualcun altro
 * ha scritto nel frattempo il server risponde CONFLICT e si sceglie quale versione tenere). I permessi sono
 * del server: qui si mostrano solo i controlli utili.
 */
export function SheetView({ sheetId }: SheetViewProps) {
  const { campaignId, isGm, upsert, remove } = useSheets();
  const toast = useToast();
  const [record, setRecord] = useState<SheetRecord | null>(null);
  const [draft, setDraft] = useState<SheetDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [query, setQuery] = useState("");
  const [section, setSection] = useState("base");

  const draftRef = useRef<SheetDoc | null>(null);
  const versionRef = useRef(0);
  const dirty = useRef(false);
  const saving = useRef(false);
  const statusRef = useRef<Status>("idle");
  const timer = useRef<number | null>(null);
  const alive = useRef(true);

  const setStatusBoth = useCallback((s: Status) => {
    statusRef.current = s;
    if (alive.current) setStatus(s);
  }, []);

  const adopt = useCallback((rec: SheetRecord) => {
    versionRef.current = rec.version;
    draftRef.current = rec.doc;
    dirty.current = false;
    setRecord(rec);
    setDraft(rec.doc);
  }, []);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    getSheet(campaignId, sheetId)
      .then((rec) => {
        if (!cancelled) adopt(rec);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(sheetErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId, sheetId, adopt]);

  const save = useCallback(async () => {
    if (saving.current || !dirty.current || statusRef.current === "conflict") return;
    const sent = draftRef.current;
    if (!sent) return;
    saving.current = true;
    dirty.current = false;
    setStatusBoth("saving");
    try {
      const rec = await saveSheet(campaignId, sheetId, { version: versionRef.current, doc: sent });
      versionRef.current = rec.version;
      upsert(rec);
      if (alive.current) setRecord((r) => (r ? { ...r, ...rec, doc: draftRef.current ?? rec.doc } : rec));
      setStatusBoth(dirty.current ? "saving" : "saved");
    } catch (err) {
      dirty.current = true;
      setStatusBoth(isConflict(err) ? "conflict" : "error");
      if (!isConflict(err)) toast.show({ title: "Salvataggio non riuscito", message: sheetErrorMessage(err), tone: "danger" });
    } finally {
      saving.current = false;
      if (dirty.current && statusRef.current === "saving") {
        timer.current = window.setTimeout(() => void save(), 0);
      }
    }
  }, [campaignId, sheetId, upsert, toast, setStatusBoth]);

  const saveRef = useRef(save);
  saveRef.current = save;

  // Alla chiusura della scheda (o del pannello) le modifiche in attesa vengono inviate subito.
  useEffect(
    () => () => {
      alive.current = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
      if (dirty.current) void saveRef.current();
    },
    []
  );

  const change = useCallback(
    (fn: (d: SheetDoc) => SheetDoc) => {
      const current = draftRef.current;
      if (!current) return;
      const next = fn(current);
      if (next === current) return;
      draftRef.current = next;
      dirty.current = true;
      setDraft(next);
      if (statusRef.current === "conflict") return;
      setStatusBoth("saving");
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void saveRef.current(), AUTOSAVE_MS);
    },
    [setStatusBoth]
  );

  const reloadLatest = async () => {
    try {
      const rec = await getSheet(campaignId, sheetId);
      adopt(rec);
      upsert(rec);
      setStatusBoth("idle");
    } catch (err) {
      toast.show({ title: "Impossibile ricaricare", message: sheetErrorMessage(err), tone: "danger" });
    }
  };

  const keepMine = async () => {
    const mine = draftRef.current;
    try {
      const latest = await getSheet(campaignId, sheetId);
      versionRef.current = latest.version;
      if (mine) {
        draftRef.current = mine;
        dirty.current = true;
      }
      statusRef.current = "idle";
      await save();
    } catch (err) {
      toast.show({ title: "Impossibile salvare", message: sheetErrorMessage(err), tone: "danger" });
    }
  };

  const saveMeta = async (patch: { ownerUserId?: string | null; tokenId?: string | null }) => {
    try {
      if (timer.current !== null) window.clearTimeout(timer.current);
      await save();
      const rec = await saveSheet(campaignId, sheetId, { version: versionRef.current, ...patch });
      versionRef.current = rec.version;
      upsert(rec);
      setRecord((r) => (r ? { ...r, ...rec, doc: draftRef.current ?? rec.doc } : rec));
    } catch (err) {
      toast.show({ title: "Modifica non riuscita", message: sheetErrorMessage(err), tone: "danger" });
    }
  };

  const doc = draft;
  const derivedResult = useMemo(() => {
    if (!doc) return null;
    try {
      return deriveDoc(doc);
    } catch {
      return null;
    }
  }, [doc]);
  const roller = useSheetRoll(doc ?? EMPTY_DOC);
  const { view } = useRealtimeState();

  if (loadError) {
    return (
      <Banner tone="danger" title="Scheda non disponibile">
        {loadError}
      </Banner>
    );
  }
  if (!record || !doc) return <Spinner label="Caricamento della scheda" size="lg" />;
  if (!derivedResult) {
    return (
      <Banner tone="danger" title="Scheda non leggibile">
        I dati di questa scheda non permettono il calcolo. Correggili da Modifica.
      </Banner>
    );
  }

  const kind = record.kind;
  const linkedToken = record.tokenId ? (view?.tokens.find((t) => t.id === record.tokenId) ?? null) : null;
  const props: SectionProps = { doc, kind, derived: derivedResult, change, roller, query, isGm };

  const tabs: TabItem[] = [
    { id: "base", label: "Base", content: <AbilitiesSection {...props} /> },
    { id: "skills", label: "Abilita'", content: <SkillsSection {...props} /> },
    { id: "combat", label: "Combattimento", content: <CombatSection {...props} /> },
    { id: "spells", label: "Magia", content: <SpellsSection {...props} /> },
    { id: "inventory", label: "Inventario", content: <InventorySection {...props} /> },
    { id: "notes", label: kind === "monster" ? "Statblock" : "Note", content: <NotesSection {...props} /> },
    {
      id: "edit",
      label: "Modifica",
      content: (
        <EditSection
          {...props}
          isGm={isGm}
          ownerUserId={record.ownerUserId}
          tokenId={record.tokenId ?? null}
          players={(view?.members ?? []).filter((m) => m.role === "player").map((m) => ({ userId: m.userId, displayName: m.displayName }))}
          tokens={view?.tokens ?? []}
          onMeta={(p) => void saveMeta(p)}
          onSyncFromToken={
            isGm && linkedToken?.health
              ? () => {
                  const h = linkedToken.health!;
                  change((d) => patchSheet(d, { hp: { ...d.sheet.hp, current: Math.min(h.current, derivedResult.hpMax), temp: h.temp } }));
                }
              : null
          }
          onDelete={() => {
            void deleteSheet(campaignId, sheetId)
              .then(() => remove(sheetId))
              .catch((err) => toast.show({ title: "Eliminazione non riuscita", message: sheetErrorMessage(err), tone: "danger" }));
          }}
        />
      )
    }
  ];

  return (
    <article className="s-view" aria-label={`Scheda di ${doc.sheet.name || "senza nome"}`}>
      <header className="s-view__head">
        <div>
          <h3 className="t-title3 s-view__name">{doc.sheet.name || "Senza nome"}</h3>
          <p className="t-footnote a-muted">
            {kind === "monster" ? "Statblock" : "Personaggio"} &middot; livello {derivedResult.level} &middot; CA {derivedResult.armorClass}
          </p>
        </div>
        <p className={`s-status s-status--${status}`} role="status" aria-live="polite">
          {status === "saving" ? <LoaderCircle size={14} aria-hidden="true" className="s-spin" /> : status === "saved" ? <Check size={14} aria-hidden="true" /> : status === "error" || status === "conflict" ? <CloudOff size={14} aria-hidden="true" /> : null}
          <span>{STATUS_TEXT[status]}</span>
        </p>
      </header>

      {status === "conflict" ? (
        <Banner tone="warning" title="La scheda e' cambiata altrove">
          <p>Qualcun altro l'ha modificata mentre la stavi modificando. Scegli quale versione tenere.</p>
          <div className="s-actions">
            <Button size="sm" variant="gray" onClick={() => void reloadLatest()}>
              Carica la versione piu' recente
            </Button>
            <Button size="sm" onClick={() => void keepMine()}>
              Tieni le mie modifiche
            </Button>
          </div>
        </Banner>
      ) : null}
      {status === "error" ? (
        <Banner tone="danger" title="Modifiche non salvate">
          <Button size="sm" onClick={() => void save()}>
            Riprova
          </Button>
        </Banner>
      ) : null}

      <SearchField label="Cerca nella scheda" placeholder="Cerca abilita', oggetti, incantesimi..." value={query} onValueChange={setQuery} />
      <Tabs aria-label={`Sezioni della scheda di ${doc.sheet.name || "senza nome"}`} tabs={tabs} value={section} onValueChange={setSection} />
    </article>
  );
}

const STATUS_TEXT: Record<Status, string> = {
  idle: "",
  saving: "Salvataggio...",
  saved: "Salvato",
  error: "Non salvato",
  conflict: "Conflitto"
};

const EMPTY_DOC: SheetDoc = blankDoc();
