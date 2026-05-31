import type { ReactNode } from "react";

/** A lightweight custom tooltip (pure CSS hover/focus — no JS state, no portal),
 *  themed to Aether's glass surface. `side` controls placement; `block` makes the
 *  wrapper full-width (for sidebar nav rows) vs inline (for toolbar buttons). */
export function Tooltip({
  label,
  side = "right",
  block = false,
  children,
}: {
  label: string;
  side?: "right" | "top" | "bottom";
  block?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`tip-wrap${block ? " tip-block" : ""}`} aria-label={label}>
      {children}
      <span role="tooltip" className={`tip tip-${side}`}>{label}</span>
    </span>
  );
}
