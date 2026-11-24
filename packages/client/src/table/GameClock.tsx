import { Clock as ClockIcon } from "lucide-react";
import { DEFAULT_CLOCK, type Clock } from "@lanterna/shared";
import { Menu, type MenuItemSpec } from "../ui";

const MINUTES_PER_DAY = 24 * 60;
/** Il nuovo giorno comincia alle 8:00, come il default della campagna. */
const DAY_START = DEFAULT_CLOCK.minute;

export function formatClock(c: Clock): string {
  const hh = String(Math.floor(c.minute / 60)).padStart(2, "0");
  const mm = String(c.minute % 60).padStart(2, "0");
  return `Giorno ${c.day} · ${hh}:${mm}`;
}

/** Avanza di `minutes` riportando il risultato in giorni e minuti (es. 23:50 + 20 min = giorno dopo 00:10). */
export function advanceClock(c: Clock, minutes: number): Clock {
  const total = (c.day - 1) * MINUTES_PER_DAY + c.minute + minutes;
  return { day: Math.floor(total / MINUTES_PER_DAY) + 1, minute: total % MINUTES_PER_DAY };
}

export interface GameClockProps {
  clock: Clock | undefined;
  isGm: boolean;
  onChange: (c: Clock) => void;
}

/**
 * Orologio di gioco nella barra del tavolo. Lo vedono tutti; solo il GM lo fa avanzare (il server
 * rifiuta gli altri comunque). Ogni modifica è un comando annullabile.
 */
export function GameClock({ clock, isGm, onChange }: GameClockProps) {
  const current = clock ?? DEFAULT_CLOCK;
  const label = formatClock(current);
  if (!isGm) {
    return (
      <span className="a-clock t-caption1" aria-label={`Orologio di gioco: ${label}`}>
        <ClockIcon size={14} aria-hidden="true" /> {label}
      </span>
    );
  }
  const items: MenuItemSpec[] = [
    { id: "10m", label: "+10 minuti", onSelect: () => onChange(advanceClock(current, 10)) },
    { id: "1h", label: "+1 ora", onSelect: () => onChange(advanceClock(current, 60)) },
    { id: "8h", label: "+8 ore", onSelect: () => onChange(advanceClock(current, 8 * 60)) },
    { id: "day", label: "Giorno successivo (ore 8:00)", onSelect: () => onChange({ day: current.day + 1, minute: DAY_START }) },
  ];
  return (
    <Menu
      label="Avanza il tempo di gioco"
      placement="bottom-end"
      items={items}
      trigger={
        <button type="button" className="a-clock a-clock--gm t-caption1" aria-label={`Orologio di gioco: ${label}. Avanza il tempo`}>
          <ClockIcon size={14} aria-hidden="true" /> {label}
        </button>
      }
    />
  );
}
