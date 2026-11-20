import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode
} from "react";
import { Check, ChevronDown } from "lucide-react";
import { Portal, cx, useControllable, useEscape, useOutsidePress, usePresence } from "./internal";

type Placement = "bottom-start" | "bottom-end" | "bottom" | "top-start" | "top-end" | "top";

interface TriggerProps {
  onClick?: (e: unknown) => void;
  "aria-haspopup"?: string;
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
}

/* ---------------- Popover ---------------- */

export interface PopoverProps {
  trigger: ReactElement<TriggerProps>;
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  placement?: Placement;
  /** Nome accessibile del pannello. */
  label: string;
  className?: string;
}

/** Pannello ancorato al trigger. Si apre dall'origine del trigger (transform-origin), Esc e click fuori chiudono. */
export function Popover({ trigger, children, open, defaultOpen = false, onOpenChange, placement = "bottom-start", label, className }: PopoverProps) {
  const [isOpen, setOpen] = useControllable(open, defaultOpen, onOpenChange);
  const { mounted, state } = usePresence(isOpen);
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  useEscape(isOpen, () => {
    setOpen(false);
    anchor.current?.querySelector<HTMLElement>("button,[tabindex]")?.focus();
  });
  useOutsidePress([anchor], isOpen, () => setOpen(false));

  const trig = isValidElement(trigger)
    ? cloneElement(trigger, {
        "aria-haspopup": "dialog",
        "aria-expanded": isOpen,
        "aria-controls": isOpen ? id : undefined,
        onClick: (e: unknown) => {
          trigger.props.onClick?.(e);
          setOpen(!isOpen);
        }
      })
    : trigger;

  return (
    <span ref={anchor} className="l-anchor">
      {trig}
      {mounted ? (
        <div ref={panel} id={id} role="dialog" aria-label={label} data-state={state} data-placement={placement} className={cx("l-popover l-material l-material--regular", className)}>
          {children}
        </div>
      ) : null}
    </span>
  );
}

/* ---------------- Menu ---------------- */

export interface MenuItemSpec {
  id: string;
  label: string;
  icon?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  /** Per Picker: voce selezionabile. */
  checked?: boolean;
  onSelect?: () => void;
}

function MenuList({ items, onClose, label, radio }: { items: MenuItemSpec[]; onClose: () => void; label: string; radio?: boolean }) {
  const list = useRef<HTMLDivElement>(null);
  const focusAt = useCallback((i: number) => {
    const els = list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])');
    if (!els || els.length === 0) return;
    els[(i + els.length) % els.length]?.focus();
  }, []);

  useEffect(() => {
    const els = list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])');
    const checked = list.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    (checked ?? els?.[0])?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    const els = Array.from(list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? []);
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") focusAt(i + 1);
    else if (e.key === "ArrowUp") focusAt(i - 1);
    else if (e.key === "Home") focusAt(0);
    else if (e.key === "End") focusAt(els.length - 1);
    else if (e.key === "Tab") onClose();
    else return;
    if (e.key !== "Tab") e.preventDefault();
  };

  return (
    <div ref={list} role="menu" aria-label={label} className="l-menu" onKeyDown={onKeyDown}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role={radio ? "menuitemradio" : it.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
          aria-checked={radio || it.checked !== undefined ? !!it.checked : undefined}
          disabled={it.disabled}
          tabIndex={-1}
          className={cx("l-menu__item", it.destructive && "l-menu__item--destructive")}
          onClick={() => {
            it.onSelect?.();
            onClose();
          }}
        >
          <span className="l-menu__label">{it.label}</span>
          {radio ? (it.checked ? <Check size={16} aria-hidden="true" /> : null) : it.icon ? <span aria-hidden="true">{it.icon}</span> : null}
        </button>
      ))}
    </div>
  );
}

export interface MenuProps {
  trigger: ReactElement<TriggerProps>;
  items: MenuItemSpec[];
  label: string;
  placement?: Placement;
}

/** Menu a comparsa (pull-down). Frecce, Home/End, Esc; il focus torna al trigger. */
export function Menu({ trigger, items, label, placement = "bottom-start" }: MenuProps) {
  const [isOpen, setOpen] = useState(false);
  const { mounted, state } = usePresence(isOpen);
  const anchor = useRef<HTMLSpanElement>(null);
  const id = useId();
  const close = useCallback(() => {
    setOpen(false);
    anchor.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);

  useEscape(isOpen, close);
  useOutsidePress([anchor], isOpen, () => setOpen(false));

  const trig = cloneElement(trigger, {
    "aria-haspopup": "menu",
    "aria-expanded": isOpen,
    "aria-controls": isOpen ? id : undefined,
    onClick: (e: unknown) => {
      trigger.props.onClick?.(e);
      setOpen(!isOpen);
    }
  });

  return (
    <span ref={anchor} className="l-anchor">
      {trig}
      {mounted ? (
        <div id={id} data-state={state} data-placement={placement} className="l-popover l-popover--menu l-material l-material--regular">
          <MenuList items={items} label={label} onClose={close} />
        </div>
      ) : null}
    </span>
  );
}

/* ---------------- Picker ---------------- */

export interface PickerOption<T extends string> {
  value: T;
  label: string;
}

export interface PickerProps<T extends string> {
  options: Array<PickerOption<T>>;
  value?: T;
  defaultValue?: T;
  onValueChange?: (v: T) => void;
  label: string;
  className?: string;
}

/** Selezione da elenco: un pulsante che mostra il valore e apre un menu con voci radio. */
export function Picker<T extends string>({ options, value, defaultValue, onValueChange, label, className }: PickerProps<T>) {
  const [current, setCurrent] = useControllable<T | undefined>(value, defaultValue ?? options[0]?.value, onValueChange as ((v: T | undefined) => void) | undefined);
  const selected = options.find((o) => o.value === current);
  const [isOpen, setOpen] = useState(false);
  const { mounted, state } = usePresence(isOpen);
  const anchor = useRef<HTMLSpanElement>(null);
  const id = useId();
  const close = useCallback(() => {
    setOpen(false);
    anchor.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  useEscape(isOpen, close);
  useOutsidePress([anchor], isOpen, () => setOpen(false));

  return (
    <span ref={anchor} className={cx("l-anchor", className)}>
      <button
        type="button"
        className="l-picker"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? id : undefined}
        aria-label={`${label}: ${selected?.label ?? ""}`}
        onClick={() => setOpen(!isOpen)}
      >
        <span>{selected?.label}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {mounted ? (
        <div id={id} data-state={state} data-placement="bottom-end" className="l-popover l-popover--menu l-material l-material--regular">
          <MenuList
            radio
            label={label}
            onClose={close}
            items={options.map((o) => ({ id: o.value, label: o.label, checked: o.value === current, onSelect: () => setCurrent(o.value) }))}
          />
        </div>
      ) : null}
    </span>
  );
}

/* ---------------- PointMenu ---------------- */

export interface PointMenuProps {
  /** Dove aprire il menu, in coordinate della finestra; `null` = chiuso. */
  position: { x: number; y: number } | null;
  items: MenuItemSpec[];
  label: string;
  onClose: () => void;
}

/**
 * Menu aperto da codice in un punto (tasto destro o pressione lunga su un elemento disegnato altrove, come
 * un token sulla mappa). Stessa resa del `ContextMenu`: Esc e click fuori chiudono, frecce per scorrere.
 */
export function PointMenu({ position, items, label, onClose }: PointMenuProps) {
  const { mounted, state } = usePresence(position !== null);
  const panel = useRef<HTMLDivElement>(null);
  const last = useRef(position);
  if (position) last.current = position;
  const shown = position ?? last.current;
  useEscape(position !== null, onClose);
  useOutsidePress([panel], position !== null, onClose);
  if (!mounted || !shown) return null;
  const x = Math.max(8, Math.min(shown.x, window.innerWidth - 232));
  const y = Math.max(8, Math.min(shown.y, window.innerHeight - (items.length * 44 + 16)));
  return (
    <Portal>
      <div ref={panel} data-state={state} className="l-popover l-popover--menu l-popover--fixed l-material l-material--regular" style={{ left: x, top: y }}>
        <MenuList items={items} label={label} onClose={onClose} />
      </div>
    </Portal>
  );
}

/* ---------------- ContextMenu ---------------- */

export interface ContextMenuProps {
  items: MenuItemSpec[];
  label: string;
  children: ReactNode;
  className?: string;
}

/** Menu contestuale: tasto destro, tasto Menu / Shift+F10, pressione prolungata su touch. */
export function ContextMenu({ items, label, children, className }: ContextMenuProps) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const { mounted, state } = usePresence(pos !== null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const last = useRef(pos);
  if (pos) last.current = pos;
  const shown = pos ?? last.current;

  const close = useCallback(() => setPos(null), []);
  useEscape(pos !== null, close);
  useOutsidePress([panel], pos !== null, close);

  const clamp = (x: number, y: number) => ({
    x: Math.max(8, Math.min(x, window.innerWidth - 232)),
    y: Math.max(8, Math.min(y, window.innerHeight - (items.length * 44 + 16)))
  });

  return (
    <div
      className={cx("l-contextzone", className)}
      onContextMenu={(e) => {
        e.preventDefault();
        setPos(clamp(e.clientX, e.clientY));
      }}
      onKeyDown={(e) => {
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          setPos(clamp(r.left + 16, r.top + 16));
        }
      }}
      onPointerDown={(e) => {
        if (e.pointerType !== "touch") return;
        const { clientX, clientY } = e;
        timer.current = setTimeout(() => setPos(clamp(clientX, clientY)), 500);
      }}
      onPointerUp={() => clearTimeout(timer.current)}
      onPointerMove={() => clearTimeout(timer.current)}
      onPointerCancel={() => clearTimeout(timer.current)}
    >
      {children}
      {mounted && shown ? (
        <Portal>
          <div
            ref={panel}
            data-state={state}
            className="l-popover l-popover--menu l-popover--fixed l-material l-material--regular"
            style={{ left: shown.x, top: shown.y }}
          >
            <MenuList items={items} label={label} onClose={close} />
          </div>
        </Portal>
      ) : null}
    </div>
  );
}
