import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode
} from "react";
import { ChevronRight } from "lucide-react";
import { cx, useControllable } from "./internal";

/* ---------------- Card / Material ---------------- */

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("l-card", className)} {...rest}>{children}</div>;
}

export interface MaterialProps extends HTMLAttributes<HTMLDivElement> {
  thickness?: "ultrathin" | "regular" | "thick";
}

/** Pannello traslucido. Non impilare materiali chiari uno sopra l'altro. */
export function Material({ thickness = "regular", className, children, ...rest }: MaterialProps) {
  return <div className={cx("l-material", `l-material--${thickness}`, "l-panel", className)} {...rest}>{children}</div>;
}

/* ---------------- List / ListRow (inset grouped) ---------------- */

export interface ListProps {
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}

export function List({ header, footer, children, className, ...aria }: ListProps) {
  const hid = useId();
  return (
    <section className={cx("l-listgroup", className)}>
      {header ? <h3 id={hid} className="l-listgroup__header">{header}</h3> : null}
      <ul className="l-list" aria-labelledby={header ? hid : undefined} aria-label={header ? undefined : aria["aria-label"]}>
        {children}
      </ul>
      {footer ? <p className="l-listgroup__footer">{footer}</p> : null}
    </section>
  );
}

export interface ListRowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Se presente la riga e' un pulsante con feedback di pressione. */
  onPress?: () => void;
  /** Mostra la freccia di navigazione. */
  chevron?: boolean;
  destructive?: boolean;
  selected?: boolean;
  disabled?: boolean;
}

export function ListRow({ title, subtitle, leading, trailing, onPress, chevron, destructive, selected, disabled }: ListRowProps) {
  const body = (
    <>
      {leading ? <span className="l-row__leading" aria-hidden="true">{leading}</span> : null}
      <span className="l-row__text">
        <span className="l-row__title">{title}</span>
        {subtitle ? <span className="l-row__subtitle">{subtitle}</span> : null}
      </span>
      {trailing ? <span className="l-row__trailing">{trailing}</span> : null}
      {chevron ? <ChevronRight size={16} className="l-row__chevron" aria-hidden="true" /> : null}
    </>
  );
  const cls = cx("l-row", destructive && "l-row--destructive", selected && "l-row--selected");
  return (
    <li className="l-listitem">
      {onPress ? (
        <button type="button" className={cls} onClick={onPress} disabled={disabled} aria-current={selected || undefined}>
          {body}
        </button>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
}

/* ---------------- NavigationBar ---------------- */

function scrollParent(el: HTMLElement | null): HTMLElement | Window {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p;
  }
  return window;
}

export interface NavigationBarProps {
  title: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Mostra il titolo grande sotto la barra; si comprime nella barra allo scorrimento. */
  largeTitle?: boolean;
  /** Forza lo stato compresso (altrimenti segue lo scroll). */
  collapsed?: boolean;
  className?: string;
}

/**
 * Barra di navigazione sticky traslucida. Il titolo grande scorre con il contenuto: quando esce dalla
 * barra, il titolo compatto compare al centro (solo opacity/transform).
 */
export function NavigationBar({ title, leading, trailing, largeTitle = true, collapsed, className }: NavigationBarProps) {
  const [scrolled, setScrolled] = useState(false);
  const bar = useRef<HTMLElement>(null);
  const large = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!largeTitle || collapsed !== undefined) return;
    const target = scrollParent(bar.current);
    let raf = 0;
    const update = () => {
      raf = 0;
      const b = bar.current?.getBoundingClientRect();
      const l = large.current?.getBoundingClientRect();
      if (b && l) setScrolled(l.bottom <= b.bottom + 4 && l.height > 0);
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    target.addEventListener("scroll", on, { passive: true });
    update();
    return () => {
      target.removeEventListener("scroll", on);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [largeTitle, collapsed]);

  const isCollapsed = largeTitle ? (collapsed ?? scrolled) : true;
  return (
    <>
      <header
        ref={bar}
        data-collapsed={isCollapsed}
        className={cx("l-navbar l-material l-material--regular", className)}
      >
        <div className="l-navbar__row">
          <div className="l-navbar__side l-navbar__side--start">{leading}</div>
          <p className="l-navbar__title" aria-hidden={largeTitle && !isCollapsed ? true : undefined}>{title}</p>
          <div className="l-navbar__side l-navbar__side--end">{trailing}</div>
        </div>
      </header>
      {largeTitle ? (
        <h1 ref={large} className="l-navlarge" data-collapsed={isCollapsed}>
          {title}
        </h1>
      ) : null}
    </>
  );
}

/* ---------------- Toolbar ---------------- */

export interface ToolbarProps {
  "aria-label": string;
  children: ReactNode;
  position?: "top" | "bottom";
  className?: string;
}

/** Barra strumenti traslucida; frecce sinistra/destra spostano il focus tra i controlli. */
export function Toolbar({ children, position = "bottom", className, ...aria }: ToolbarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("button:not([disabled]),a[href],input,[role='switch']") ?? []);
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const n = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    e.preventDefault();
    items[n]?.focus();
  };
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={aria["aria-label"]}
      data-position={position}
      className={cx("l-toolbar l-material l-material--regular", className)}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}

/* ---------------- Sidebar ---------------- */

export interface SidebarItem {
  id: string;
  label: string;
  icon?: ReactNode;
  badge?: ReactNode;
}
export interface SidebarSection {
  title?: string;
  items: SidebarItem[];
}
export interface SidebarProps {
  sections: SidebarSection[];
  selected?: string;
  onSelect?: (id: string) => void;
  "aria-label": string;
  className?: string;
}

export function Sidebar({ sections, selected, onSelect, className, ...aria }: SidebarProps) {
  return (
    <nav aria-label={aria["aria-label"]} className={cx("l-sidebar l-material l-material--thick", className)}>
      {sections.map((s, si) => (
        <div key={s.title ?? si} className="l-sidebar__section">
          {s.title ? <p className="l-sidebar__title">{s.title}</p> : null}
          <ul className="l-sidebar__list">
            {s.items.map((it) => (
              <li key={it.id}>
                <button
                  type="button"
                  className="l-sidebar__item"
                  aria-current={selected === it.id ? "page" : undefined}
                  onClick={() => onSelect?.(it.id)}
                >
                  {it.icon ? <span className="l-sidebar__icon" aria-hidden="true">{it.icon}</span> : null}
                  <span className="l-sidebar__label">{it.label}</span>
                  {it.badge ? <span className="l-sidebar__badge">{it.badge}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/* ---------------- Tabs ---------------- */

export interface TabItem {
  id: string;
  label: string;
  content: ReactNode;
  icon?: ReactNode;
  /** Contatore (es. nuovi messaggi): pallino numerico accanto all'etichetta, letto dagli screen reader. */
  badge?: number;
}
export interface TabsProps {
  tabs: TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (id: string) => void;
  "aria-label": string;
  className?: string;
}

export function Tabs({ tabs, value, defaultValue, onValueChange, className, ...aria }: TabsProps) {
  const [current, setCurrent] = useControllable<string | undefined>(value, defaultValue ?? tabs[0]?.id, onValueChange as ((v: string | undefined) => void) | undefined);
  const base = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(0, tabs.findIndex((t) => t.id === current));

  const go = (i: number) => {
    const n = (i + tabs.length) % tabs.length;
    setCurrent(tabs[n]!.id);
    refs.current[n]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    if (e.key === "ArrowRight") go(i + 1);
    else if (e.key === "ArrowLeft") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(tabs.length - 1);
    else return;
    e.preventDefault();
  };

  const style = { "--tab-count": tabs.length, "--tab-index": index } as CSSProperties;
  return (
    <div className={cx("l-tabs", className)}>
      <div role="tablist" aria-label={aria["aria-label"]} className="l-tabs__list" style={style}>
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={i === index}
            aria-controls={`${base}-panel-${t.id}`}
            tabIndex={i === index ? 0 : -1}
            className="l-tabs__tab"
            onClick={() => setCurrent(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.icon ? <span aria-hidden="true">{t.icon}</span> : null}
            {t.label}
            {t.badge ? (
              <>
                <span className="l-badge l-badge--tint l-tabs__badge" aria-hidden="true">
                  {t.badge > 99 ? "99+" : t.badge}
                </span>
                <span className="l-sr-only">{`, ${t.badge} nuovi`}</span>
              </>
            ) : null}
          </button>
        ))}
        <span className="l-tabs__indicator" aria-hidden="true" />
      </div>
      {tabs.map((t, i) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={i !== index}
          tabIndex={0}
          className="l-tabs__panel"
        >
          {i === index ? t.content : null}
        </div>
      ))}
    </div>
  );
}
