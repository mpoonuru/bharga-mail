import { AnimatePresence, motion } from "motion/react";
import { useApp } from "@/store";
import { Icon, type IconName } from "@/components/icons";
import { OVERLAY_FADE, useMotionTransition } from "@/lib/motion";

const ICONS: Record<string, IconName> = {
  anthropic: "ai",
  "openai-compatible": "cloud",
  google: "cloud",
  local: "local",
  custom: "plug",
};

// Quick switcher popover (the bottom-left engine chip + ⌘\).
export function ModelPicker() {
  const overlayTransition = useMotionTransition(OVERLAY_FADE);
  const { modelPickerOpen, setModelPicker, ai, setView } = useApp();

  return (
    <AnimatePresence>
      {modelPickerOpen && ai && <>
      <motion.div
        style={{ position: "fixed", inset: 0, zIndex: 39 }}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={overlayTransition}
        onClick={() => setModelPicker(false)}
      />
      <motion.div className="pop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={overlayTransition}>
        <h4>Bring-your-own AI · per role</h4>
        {ai.models.map((m) => {
          const primary = m.roles[0];
          return (
            <div key={m.id} className={`m${m.ready ? " on" : ""}`}>
              <Icon name={ICONS[m.kind]} size={16} weight="duotone" /> {m.label}
              <span className="badge">
                {m.ready ? (primary ? cap(primary) : "ready") : "add key"}
              </span>
            </div>
          );
        })}
        <div className="pf">
          Profile: <b>{ai.name}</b> · credentials encrypted locally ·{" "}
          <button
            className="chip"
            style={{ padding: "2px 8px", fontSize: 11 }}
            onClick={() => { setView("settings"); setModelPicker(false); }}
          >
            Configure
          </button>
        </div>
      </motion.div>
      </>}
    </AnimatePresence>
  );
}

function cap(s: string) {
  return s[0].toUpperCase() + s.slice(1);
}
