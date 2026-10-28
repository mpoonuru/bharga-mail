import { cloneElement, isValidElement, type ReactNode } from "react";

type LabelableProps = {
  "aria-label"?: string;
  "aria-labelledby"?: string;
};

/** A lightweight custom tooltip (pure CSS hover/focus — no JS state, no portal),
 *  themed to the shared overlay surface. `side` controls placement; `block` makes the
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
  const control = isValidElement<LabelableProps>(children)
    && !children.props["aria-label"]
    && !children.props["aria-labelledby"]
      ? cloneElement(children, { "aria-label": label })
      : children;

  return (
    <span className={`tip-wrap${block ? " tip-block" : ""}`}>
      {control}
      <span aria-hidden="true" role="tooltip" className={`tip tip-${side}`}>{label}</span>
    </span>
  );
}
