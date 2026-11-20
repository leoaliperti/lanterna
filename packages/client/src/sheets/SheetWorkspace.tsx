import { useEffect, useState } from "react";
import { Columns2, X } from "lucide-react";
import { IconButton, Menu, Sheet, useToast, type MenuItemSpec } from "../ui";
import { useChatStore } from "../chat";
import { SheetView } from "./SheetView";
import { useSheets } from "./SheetsProvider";

const WIDE = "(min-width: 56rem)";

function useWide(): boolean {
  const query = () => (typeof window.matchMedia === "function" ? window.matchMedia(WIDE).matches : false);
  const [wide, setWide] = useState(query);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return wide;
}

/**
 * Finestra delle schede: piu' schede aperte insieme, ognuna con la sua linguetta. Su schermi larghi se ne possono
 * affiancare due; su telefono e tablet stretto se ne vede una alla volta. Le schede aperte restano montate (nascoste)
 * cosi' le bozze non si perdono cambiando linguetta.
 */
export function SheetWorkspace() {
  const { sheets, openIds, activeId, sideId, workspaceOpen, setWorkspaceOpen, activate, close, setSide, user } = useSheets();
  const wide = useWide();
  const toast = useToast();
  const chat = useChatStore();

  // L'esito dei tiri fatti dalla scheda compare qui sopra la finestra (la chat resta sotto).
  useEffect(() => {
    if (!workspaceOpen) return;
    return chat.onRoll((entry) => {
      if (entry.authorId !== user.id) return;
      toast.show({ title: entry.label ?? entry.formula, message: entry.detail, duration: 6000, tone: entry.critical ? "success" : entry.criticalFailure ? "danger" : "info" });
    });
  }, [chat, workspaceOpen, toast, user.id]);

  const nameOf = (id: string) => sheets.find((s) => s.id === id)?.name || "Senza nome";
  const current = activeId && openIds.includes(activeId) ? activeId : (openIds[0] ?? null);
  const side = wide && sideId && sideId !== current && openIds.includes(sideId) ? sideId : null;

  const splitItems: MenuItemSpec[] = [
    ...openIds.filter((id) => id !== current).map((id) => ({ id: `side-${id}`, label: `Affianca: ${nameOf(id)}`, onSelect: () => setSide(id) })),
    ...(side ? [{ id: "unsplit", label: "Chiudi l'affiancamento", onSelect: () => setSide(null) }] : [])
  ];

  return (
    <Sheet open={workspaceOpen && openIds.length > 0} onOpenChange={setWorkspaceOpen} title="Schede" className="s-workspace">
      <div className="s-tabs-bar">
        <div role="tablist" aria-label="Schede aperte" className="s-tabs">
          {openIds.map((id) => (
            <span key={id} className="s-tab" data-active={id === current || id === side}>
              <button
                type="button"
                role="tab"
                id={`sheet-tab-${id}`}
                aria-selected={id === current}
                aria-controls={`sheet-pane-${id}`}
                className="s-tab__main"
                onClick={() => activate(id)}
              >
                {nameOf(id)}
              </button>
              <IconButton label={`Chiudi ${nameOf(id)}`} icon={<X size={14} />} onClick={() => close(id)} className="s-tab__close" />
            </span>
          ))}
        </div>
        {wide && openIds.length > 1 ? (
          <Menu label="Affianca schede" placement="bottom-end" items={splitItems} trigger={<IconButton label="Affianca una scheda" icon={<Columns2 size={18} />} />} />
        ) : null}
      </div>
      <div className="s-panes" data-split={side ? "true" : "false"}>
        {openIds.map((id) => {
          const shown = id === current || id === side;
          return (
            <div
              key={id}
              id={`sheet-pane-${id}`}
              role="tabpanel"
              aria-labelledby={`sheet-tab-${id}`}
              className="s-pane"
              hidden={!shown}
            >
              <SheetView sheetId={id} />
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}
