import type { ReactNode } from "react";

/** A lightweight custom tooltip (pure CSS hover/focus — no JS state, no portal),
 *  adapted from the topup-arena pattern but themed to Aether's glass surface.
 *  Used for the collapsed sidebar icons; `side` controls bubble placement. */
export function Tooltip({
  label,
  side = "right",
  children,
}: {
  label: string;
  side?: "right" | "top";
  children: ReactNode;
}) {
  return (
    <span className="tip-wrap" aria-label={label}>
      {children}
      <span role="tooltip" className={`tip tip-${side}`}>{label}</span>
    </span>
  );
}
