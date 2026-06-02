import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useApp } from "@/store";
import { Sidebar } from "@/components/Sidebar";
import { Stream } from "@/components/Stream";
import { Stage } from "@/components/Stage";
import { Compose } from "@/components/Compose";
import { CalendarView } from "@/components/CalendarView";
import { TasksView } from "@/components/TasksView";
import { Settings } from "@/components/Settings";
import { CommandBar } from "@/components/CommandBar";
import { ModelPicker } from "@/components/ModelPicker";
import { UndoToast } from "@/components/UndoToast";
import { Icon } from "@/components/icons";
import { useHotkeys } from "@/lib/useHotkeys";
import { useViewport } from "@/lib/useViewport";
import { applyFont, applyLocale } from "@/lib/prefs";
import { toggleMaximizeWindow, startWindowDrag } from "@/lib/bridge";

export function App() {
  const { view, load, focusMode, composeOpen, theme, density } = useApp();
  const layout = useViewport();
  useHotkeys();

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.setAttribute("data-density", density);
    applyFont(useApp.getState().font);
    applyLocale(useApp.getState().locale);
    void load();
    // Subscribe to background live-sync (auto-refresh inbox + notify on new mail).
    void useApp.getState().startLiveSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Native desktop window behaviours:
  //  • double-click the title-bar (drag region) → zoom/maximize (macOS standard)
  //  • suppress the webview's default right-click menu (Reload/Inspect) everywhere
  //    except editable fields, where the native copy/paste menu is wanted.
  useEffect(() => {
    // Anything interactive that must keep its own click/drag must be excluded here.
    const NO_DRAG = "button, input, textarea, select, a, [role='button'], [contenteditable='true'], .ProseMirror, .recip-chip, .splitter";
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement | null;
      if (!t || t.closest(NO_DRAG)) return;
      // Grab anywhere inside a header drag-region (title text, logo, empty space)
      // and move the window — Tauri's native attribute alone barely grabs anything.
      if (t.closest("[data-tauri-drag-region]")) void startWindowDrag();
    };
    const onDblClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || t.closest("button, input, textarea, a, [role='button'], .ProseMirror")) return;
      if (t.closest("[data-tauri-drag-region]")) void toggleMaximizeWindow();
    };
    const onContextMenu = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest("input, textarea, [contenteditable='true'], .ProseMirror")) return;
      e.preventDefault();
    };
    // Capture phase: the sidebar uses Framer Motion (Reorder/motion) which can
    // stopPropagation on mousedown in the bubble phase, swallowing the drag in the
    // left column. Capture fires at document first, before any child handler.
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("dblclick", onDblClick);
    document.addEventListener("contextmenu", onContextMenu);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("dblclick", onDblClick);
      document.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);

  return (
    <>
      {layout === "narrow" ? <NarrowLayout /> : <WideLayout rail={layout === "medium"} focusMode={focusMode} composeOpen={composeOpen} view={view} />}
      <CommandBar />
      <ModelPicker />
      <UndoToast />
      {layout !== "narrow" && <FloatingUtils />}
    </>
  );
}

function isFull(view: string) {
  return view === "calendar" || view === "tasks" || view === "settings";
}

// A thin draggable column divider. Reports the new width (clamped) as you drag.
function Splitter({ left, value, min, max, onChange, onCommit }: {
  left: number; value: number; min: number; max: number;
  onChange: (v: number) => void; onCommit: (v: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startVal = value;
    const clamp = (v: number) => Math.max(min, Math.min(max, v));
    setDragging(true);
    const move = (ev: PointerEvent) => onChange(clamp(startVal + (ev.clientX - startX)));
    const up = (ev: PointerEvent) => {
      onCommit(clamp(startVal + (ev.clientX - startX)));
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return <div className={`splitter${dragging ? " dragging" : ""}`} style={{ left }} onPointerDown={onPointerDown} role="separator" aria-orientation="vertical" />;
}

// ---- Wide (desktop) & Medium (rail) : grid layout ----
function WideLayout({ rail, focusMode, composeOpen, view }: { rail: boolean; focusMode: boolean; composeOpen: boolean; view: string }) {
  const { panelSidebarW, panelStreamW, setPanelWidths, sidebarCollapsed } = useApp();
  const [resizing, setResizing] = useState(false);
  // Effective rail = viewport-driven medium rail OR the user's manual collapse.
  const railEffective = rail || sidebarCollapsed;
  const sidebarW = railEffective ? 64 : panelSidebarW;
  const streamW = focusMode ? 0 : rail ? 320 : panelStreamW;
  const cols = isFull(view) ? `${sidebarW}px 1fr` : `${sidebarW}px ${streamW}px 1fr`;
  const showStreamSplitter = !rail && !focusMode && !isFull(view);

  return (
    <div className="app" style={{ gridTemplateColumns: cols, position: "relative", transition: resizing ? "none" : undefined }}>
      <Sidebar rail={railEffective} />
      {isFull(view) ? (
        <FullPage />
      ) : (
        <>
          <Stream />
          {composeOpen ? <Compose /> : <Stage />}
        </>
      )}
      {!railEffective && (
        <Splitter left={sidebarW} value={sidebarW} min={180} max={380}
          onChange={(v) => { setResizing(true); setPanelWidths(v, panelStreamW); }}
          onCommit={(v) => { setPanelWidths(v, panelStreamW, true); setResizing(false); }} />
      )}
      {showStreamSplitter && (
        <Splitter left={sidebarW + streamW} value={streamW} min={280} max={640}
          onChange={(v) => { setResizing(true); setPanelWidths(panelSidebarW, v); }}
          onCommit={(v) => { setPanelWidths(panelSidebarW, v, true); setResizing(false); }} />
      )}
    </div>
  );
}

// ---- Narrow (iPad portrait / phone) : single pane + drawer ----
function NarrowLayout() {
  const { view, composeOpen, mobileStage, drawerOpen, setDrawer, backToStream } = useApp();
  const full = isFull(view);
  const showStage = !full && (composeOpen || mobileStage);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        {showStage ? (
          <button className="iconbtn" title="Back" onClick={backToStream}><Icon name="awaiting" /></button>
        ) : (
          <button className="iconbtn" title="Menu" onClick={() => setDrawer(true)}><Icon name="more" /></button>
        )}
        <b className="text-[14px] capitalize">{full ? view : showStage ? "Conversation" : view}</b>
        <div className="ml-auto flex gap-2">
          <ThemeButton />
          <CommandButton />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {full ? <FullPage /> : composeOpen ? <Compose /> : mobileStage ? <Stage /> : <Stream />}
      </div>

      {/* Off-canvas sidebar drawer */}
      <AnimatePresence>
        {drawerOpen && (
          <>
            <motion.div
              className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setDrawer(false)}
            />
            <motion.div
              className="fixed inset-y-0 left-0 z-50 w-[264px]"
              initial={{ x: -280 }} animate={{ x: 0 }} exit={{ x: -280 }}
              transition={{ type: "spring", stiffness: 320, damping: 32 }}
            >
              <Sidebar />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function FullPage() {
  const view = useApp((s) => s.view);
  return (
    <div className="page" style={{ gridColumn: "2 / 4" }}>
      {view === "calendar" && <CalendarView />}
      {view === "tasks" && <TasksView />}
      {view === "settings" && <Settings />}
    </div>
  );
}

function ThemeButton() {
  const { toggleTheme, theme } = useApp();
  return <button className="iconbtn" title="Toggle theme" onClick={toggleTheme}><Icon name={theme === "dark" ? "sun" : "moon"} size={14} /></button>;
}
function CommandButton() {
  const setCmd = useApp((s) => s.setCmd);
  return <button className="iconbtn" title="Command (⌘K)" onClick={() => setCmd(true)}><Icon name="command" size={14} /></button>;
}

function FloatingUtils() {
  const { toggleTheme, setCmd, theme } = useApp();
  return (
    <div className="util">
      <button onClick={toggleTheme} className="inline-flex items-center gap-1.5">
        <Icon name={theme === "dark" ? "sun" : "moon"} size={14} /> {theme === "dark" ? "Light" : "Dark"}
      </button>
      <button onClick={() => setCmd(true)} className="inline-flex items-center gap-1.5">
        <Icon name="command" size={14} /> Command
      </button>
    </div>
  );
}
