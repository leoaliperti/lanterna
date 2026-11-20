import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}

/** Stato vuoto: icona, titolo breve, una frase che dice cosa succedera'. */
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="a-empty">
      <span className="a-empty__icon" aria-hidden="true">
        {icon}
      </span>
      <p className="t-headline">{title}</p>
      <p className="t-subhead a-muted">{description}</p>
      {action}
    </div>
  );
}
