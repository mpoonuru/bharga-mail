import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Select } from "@/components/ui/Select";
import { Tooltip } from "@/components/ui/Tooltip";
import type { MessageDisplay, MessageLayout } from "@/lib/emailFrameLayout";

interface DisplayContext extends MessageDisplay {
  setLayout: (layout: MessageLayout) => void;
  setZoom: (zoom: number) => void;
}

export const ZOOM_LEVELS = [50, 75, 90, 100, 110, 125, 150, 175, 200] as const;
const DEFAULT_DISPLAY: MessageDisplay = { layout: "fit", zoom: 100 };
const Context = createContext<DisplayContext | null>(null);

export function ReaderDisplayProvider({ children }: { children: ReactNode }) {
  const [layout, setLayout] = useState<MessageLayout>("fit");
  const [zoom, setZoom] = useState(100);
  const value = useMemo(() => ({ layout, zoom, setLayout, setZoom }), [layout, zoom]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useReaderDisplay(): MessageDisplay {
  return useContext(Context) ?? DEFAULT_DISPLAY;
}

export function ReaderDisplayControls() {
  const display = useContext(Context);
  if (!display) return null;
  const { layout, zoom, setLayout, setZoom } = display;
  const index = ZOOM_LEVELS.findIndex((level) => level === zoom);
  return (
    <div className="reader-display-controls" role="group" aria-label="Message display">
      <Select
        className="reader-layout-select"
        ariaLabel="Message layout"
        value={layout}
        onChange={(value) => setLayout(value === "original" ? "original" : "fit")}
        options={[{ value: "fit", label: "Fit width" }, { value: "original", label: "Original layout" }]}
      />
      <div className="reader-zoom" role="group" aria-label="Message zoom controls">
        <Tooltip label="Zoom out" side="bottom">
          <button type="button" className="iconbtn" aria-label="Zoom out" disabled={index <= 0} onClick={() => setZoom(ZOOM_LEVELS[Math.max(0, index - 1)])}>−</button>
        </Tooltip>
        <Select ariaLabel="Message zoom" value={String(zoom)} onChange={(value) => {
          const next = ZOOM_LEVELS.find((level) => level === Number(value));
          if (next !== undefined) setZoom(next);
        }} options={ZOOM_LEVELS.map((level) => ({ value: String(level), label: `${level}%` }))} />
        <Tooltip label="Zoom in" side="bottom">
          <button type="button" className="iconbtn" aria-label="Zoom in" disabled={index >= ZOOM_LEVELS.length - 1} onClick={() => setZoom(ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, index + 1)])}>+</button>
        </Tooltip>
      </div>
    </div>
  );
}
