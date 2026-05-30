import { useEffect } from "react";
import { useApp } from "@/store";
import type { View } from "@/types";

// Global keyboard control — the "Calm Command" gesture plus Superhuman-style
// list navigation (j/k move, Enter open, e archive, s snooze, c compose, f focus).
export function useHotkeys() {
  const { setCmd, toggleFocus, setCompose, cmdOpen } = useApp();

  useEffect(() => {
    function currentList() {
      const s = useApp.getState();
      return s.threads.filter((t) => t.view.includes(s.view as View));
    }
    function move(delta: number) {
      const s = useApp.getState();
      const list = currentList();
      if (list.length === 0) return;
      const idx = list.findIndex((t) => t.id === s.selectedThreadId);
      const next = Math.max(0, Math.min(list.length - 1, (idx === -1 ? 0 : idx) + delta));
      s.selectThread(list[next].id);
    }

    function onKey(e: KeyboardEvent) {
      const typing = ["INPUT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName) ||
        (e.target as HTMLElement)?.isContentEditable;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmd(true);
        return;
      }
      if (e.key === "Escape") {
        setCmd(false);
        useApp.getState().setModelPicker(false);
        useApp.getState().setDrawer(false);
        return;
      }
      if (typing || cmdOpen) return;
      // Single-letter shortcuts must not hijack modifier combos like Ctrl/Cmd+C
      // (copy), Cmd+A (select all), etc.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const s = useApp.getState();
      switch (e.key.toLowerCase()) {
        case "j": move(1); break;
        case "k": move(-1); break;
        case "f": toggleFocus(); break;
        case "c": setCompose(true); break;
        case "/": e.preventDefault(); setCmd(true); break;
        case "e": if (s.selectedThreadId) s.archiveThread(s.selectedThreadId); break;
        case "s": if (s.selectedThreadId) s.snoozeThread(s.selectedThreadId); break;
        case "u": if (s.selectedThreadId) s.toggleRead(s.selectedThreadId); break;
        default: break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setCmd, toggleFocus, setCompose, cmdOpen]);
}
