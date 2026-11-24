import { memo } from "react";
import { Dices, EyeOff, Lock, Sparkles, TriangleAlert } from "lucide-react";
import type { ChatLogEntry, Member } from "@lanterna/shared";
import { formatTime, privacyLabel } from "./describe";
import { presenceColor } from "../presence/colors";

export interface ChatEntryViewProps {
  entry: ChatLogEntry;
  selfId: string;
  members: readonly Member[];
}

/**
 * Una voce del log. Il testo (messaggi, etichette, nomi) e' sempre un nodo di testo React:
 * mai HTML (vedi docs/PROTOCOL.md, "Testo semplice"). Il risultato dei tiri e' quello del server.
 */
export const ChatEntryView = memo(function ChatEntryView({ entry, selfId, members }: ChatEntryViewProps) {
  const priv = privacyLabel(entry, selfId, members);
  const mine = entry.authorId === selfId;
  // Stesso colore di freccia e ping sulla mappa: il GM e ogni giocatore si distinguono a colpo d'occhio.
  const authorIsGm = members.some((m) => m.userId === entry.authorId && m.role === "admin");
  const authorColor = presenceColor(entry.authorId, authorIsGm);
  const classes = ["a-chat__entry"];
  if (mine) classes.push("a-chat__entry--mine");
  if (priv) classes.push("a-chat__entry--private");
  if (entry.kind === "roll") {
    classes.push("a-chat__entry--roll");
    if (entry.critical) classes.push("a-chat__entry--crit");
    if (entry.criticalFailure) classes.push("a-chat__entry--fumble");
  }

  return (
    <li className={classes.join(" ")} data-private={priv ? "true" : undefined} data-kind={entry.kind}>
      <div className="a-chat__meta t-caption1">
        <span className="a-chat__author" style={{ color: authorColor }}>{mine ? "Tu" : entry.authorName}{authorIsGm ? " · GM" : ""}</span>
        <time className="a-muted" dateTime={new Date(entry.at).toISOString()}>
          {formatTime(entry.at)}
        </time>
        {priv ? (
          <span className="a-chat__lock">
            {entry.visibility === "gm" ? <EyeOff size={12} aria-hidden="true" /> : <Lock size={12} aria-hidden="true" />}
            {priv}
          </span>
        ) : null}
      </div>
      {entry.kind === "message" ? (
        <p className="a-chat__text t-body">{entry.text}</p>
      ) : (
        <div className="a-chat__roll">
          <div className="a-chat__rollhead t-subhead">
            <Dices size={14} aria-hidden="true" />
            <span className="a-chat__rolllabel">{entry.label ?? "Tiro"}</span>
            <span className="a-chat__formula a-muted">{entry.formula}</span>
          </div>
          <div className="a-chat__result">
            <span className="a-chat__total" aria-label={`Totale ${entry.total}`}>
              {entry.total}
            </span>
            {entry.critical ? (
              <span className="a-chat__flag a-chat__flag--crit t-caption1">
                <Sparkles size={12} aria-hidden="true" /> Critico
              </span>
            ) : null}
            {entry.criticalFailure ? (
              <span className="a-chat__flag a-chat__flag--fumble t-caption1">
                <TriangleAlert size={12} aria-hidden="true" /> Fallimento critico
              </span>
            ) : null}
          </div>
          <p className="a-chat__detail t-footnote">{entry.detail}</p>
        </div>
      )}
    </li>
  );
});
