// Keeps gesture-only interactions off mouse and trackpad layouts.
import { useEffect, useState } from "react";

const COARSE_POINTER = "(pointer: coarse)";

export function mailDragPolicy(coarse: boolean) {
  return coarse
    ? { drag: "x" as const, dragElastic: 0.35 }
    : { drag: false as const, dragElastic: 0 };
}

export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() =>
    typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(COARSE_POINTER).matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(COARSE_POINTER);
    const update = () => setCoarse(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return coarse;
}
