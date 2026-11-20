import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowDown, Lock, Send } from "lucide-react";
import type { SessionUser } from "../api/client";
import { commandErrorToast } from "../realtime/errors";
import { useRealtimeState } from "../realtime/RealtimeProvider";
import { Button, IconButton, Spinner, TextField, useToast } from "../ui";
import { ChatEntryView } from "./ChatEntryView";
import { useChat, useChatStore } from "./ChatProvider";
import { parseChatInput, whisperTargets } from "./commands";
import { DiceBar, useRoll } from "./DiceBar";
import { RecipientSelect } from "./RecipientSelect";

import "./chat.css";

const NEAR_BOTTOM_PX = 48;

export interface ChatPanelProps {
  user: SessionUser;
}

/** Scheda Chat: cronologia, tiri, campo di invio con whisper e comandi, barra dei dadi. */
export function ChatPanel({ user }: ChatPanelProps) {
  const store = useChatStore();
  const { entries, hasMore, loadingOlder, composer, pendingFocus } = useChat();
  const { view } = useRealtimeState();
  const members = useMemo(() => view?.members ?? [], [view]);
  const self = useMemo(() => ({ userId: user.id, role: user.role }), [user.id, user.role]);
  const isGm = user.role === "admin";
  const targets = useMemo(() => whisperTargets(members, self), [members, self]);
  const roll = useRoll(isGm, targets);
  const toast = useToast();

  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLOListElement>(null);
  const stuck = useRef(true);
  const prev = useRef<{ first: string | null; last: string | null; height: number }>({ first: null, last: null, height: 0 });
  const [missed, setMissed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Se il destinatario scelto non e' piu' valido (ruolo o membri cambiati) si torna a "tutti".
  const recipient = composer.recipient && targets.some((t) => t.userId === composer.recipient) ? composer.recipient : null;
  const recipientName = targets.find((t) => t.userId === recipient)?.displayName;

  // Scorciatoia "/" o Invio: il cursore va nel campo.
  useEffect(() => {
    if (!pendingFocus) return;
    inputRef.current?.focus();
    store.consumeFocus();
  }, [pendingFocus, store]);

  // Scorrimento: segue i nuovi messaggi solo se si e' in fondo; se si e' risaliti non strappa la lettura.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const first = entries[0]?.id ?? null;
    const last = entries[entries.length - 1]?.id ?? null;
    const p = prev.current;
    if (p.last === null) {
      el.scrollTop = el.scrollHeight; // primo disegno
    } else if (first !== p.first && last === p.last) {
      el.scrollTop += el.scrollHeight - p.height; // pagina più vecchia in testa: la riga letta resta ferma
    } else if (last !== p.last) {
      const own = entries[entries.length - 1]?.authorId === user.id;
      if (stuck.current || own) {
        el.scrollTop = el.scrollHeight;
        stuck.current = true;
        setMissed(0);
      } else {
        const idx = entries.findIndex((e) => e.id === p.last);
        setMissed((n) => n + (idx < 0 ? 1 : entries.length - 1 - idx));
      }
    }
    prev.current = { first, last, height: el.scrollHeight };
  }, [entries, user.id]);

  const onScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    if (stuck.current) setMissed(0);
  }, []);

  const toBottom = () => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stuck.current = true;
    setMissed(0);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const parsed = parseChatInput(composer.text, { members, self, recipient });
    if (parsed.kind === "error") {
      setError(parsed.message);
      return;
    }
    setBusy(true);
    setError(null);
    if (parsed.kind === "roll") {
      const message = await roll(parsed.formula);
      setBusy(false);
      if (message) setError(message);
      else store.patchComposer({ text: "" });
      return;
    }
    const r = await store.sendChat(parsed.text, parsed.whisperTo);
    setBusy(false);
    if (r.ok) {
      store.patchComposer({ text: "" });
      stuck.current = true;
    } else if (r.code === "INVALID") setError(r.message.charAt(0).toUpperCase() + r.message.slice(1));
    else toast.show(commandErrorToast(r));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.currentTarget.blur();
      document.getElementById("mappa")?.focus();
    }
  }

  return (
    <div className="a-chat">
      <div className="a-chat__logwrap">
        <ol ref={logRef} className="a-chat__log" aria-label="Messaggi e tiri" onScroll={onScroll} tabIndex={0}>
          {hasMore ? (
            <li className="a-chat__older">
              <Button variant="plain" size="sm" onClick={() => void store.loadOlder()} disabled={loadingOlder}>
                Carica messaggi precedenti
              </Button>
              {loadingOlder ? <Spinner label="Caricamento dei messaggi" size="sm" /> : null}
            </li>
          ) : null}
          {entries.length === 0 ? (
            <li className="a-chat__empty t-subhead a-muted">Nessun messaggio. Scrivi qualcosa o tira un dado.</li>
          ) : (
            entries.map((entry) => <ChatEntryView key={entry.id} entry={entry} selfId={user.id} members={members} />)
          )}
        </ol>
        {missed > 0 ? (
          <button type="button" className="a-chat__missed t-footnote a-enter" onClick={toBottom}>
            <ArrowDown size={14} aria-hidden="true" />
            {missed === 1 ? "1 nuovo messaggio" : `${missed} nuovi messaggi`}
          </button>
        ) : null}
      </div>

      <DiceBar isGm={isGm} targets={targets} />

      <form className="a-chat__form" onSubmit={(e) => void submit(e)} noValidate>
        {targets.length > 0 ? (
          <RecipientSelect
            targets={targets}
            value={recipient}
            onChange={(r) => store.patchComposer({ recipient: r })}
            label="Invia a"
          />
        ) : null}
        {recipientName ? (
          <p className="a-chat__private t-caption1">
            <Lock size={12} aria-hidden="true" /> Sussurro a {recipientName}: lo vedete solo voi due.
          </p>
        ) : null}
        <div className="a-chat__send">
          <TextField
            ref={inputRef}
            label="Messaggio"
            hideLabel
            placeholder={recipientName ? `Sussurra a ${recipientName}` : "Messaggio, /r 2d6+3, /w nome testo"}
            value={composer.text}
            maxLength={2000}
            autoComplete="off"
            enterKeyHint="send"
            error={error ?? undefined}
            className={recipientName ? "a-chat__field--private" : undefined}
            onChange={(e) => {
              setError(null);
              store.patchComposer({ text: e.target.value });
            }}
            onKeyDown={onKeyDown}
          />
          <IconButton type="submit" label="Invia" variant="filled" icon={<Send size={18} />} disabled={busy || composer.text.trim() === ""} />
        </div>
      </form>
    </div>
  );
}
