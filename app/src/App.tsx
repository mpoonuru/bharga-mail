import { useEffect } from "react";
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

// ---- Wide (desktop) & Medium (rail) : grid layout ----
function WideLayout({ rail, focusMode, composeOpen, view }: { rail: boolean; focusMode: boolean; composeOpen: boolean; view: string }) {
  const sidebarW = rail ? 64 : 234;
  const streamW = focusMode ? 0 : rail ? 320 : 360;
  const cols = isFull(view) ? `${sidebarW}px 1fr` : `${sidebarW}px ${streamW}px 1fr`;

  return (
    <div className="app" style={{ gridTemplateColumns: cols }}>
      <Sidebar rail={rail} />
      {isFull(view) ? (
        <FullPage />
      ) : (
        <>
          <Stream />
          {composeOpen ? <Compose /> : <Stage />}
        </>
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
