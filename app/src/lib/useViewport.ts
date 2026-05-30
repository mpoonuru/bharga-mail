import { useSyncExternalStore } from "react";

export type Layout = "wide" | "medium" | "narrow";

// Breakpoints (px). wide = full 3-pane; medium = sidebar rail + 2 panes;
// narrow = single pane (iPad portrait / phone).
const MEDIUM = 1080;
const NARROW = 760;

function layoutFor(w: number): Layout {
  if (w < NARROW) return "narrow";
  if (w < MEDIUM) return "medium";
  return "wide";
}

function subscribe(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}

/** Reactive layout tier driven by window width (SSR-safe via useSyncExternalStore). */
export function useViewport(): Layout {
  return useSyncExternalStore(
    subscribe,
    () => layoutFor(window.innerWidth),
    () => "wide" as Layout
  );
}
