import { motion } from "motion/react";
import { useApp } from "@/store";
import { Icon, type IconName } from "@/components/icons";

const ICONS: Record<string, IconName> = {
  anthropic: "ai",
  "openai-compatible": "cloud",
  google: "cloud",
  local: "local",
  custom: "plug",
};

// Quick switcher popover (the bottom-left engine chip + ⌘\).
export function ModelPicker() {
  const { modelPickerOpen, setModelPicker, ai, setView } = useApp();
  if (!modelPickerOpen || !ai) return null;

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 39 }} onClick={() => setModelPicker(false)} />
      <motion.div className="pop" initial={{ y: 10, opacity: 0, scale: 0.98 }} animate={{ y: 0, opacity: 1, scale: 1 }} transition={{ type: "spring", stiffness: 320, damping: 26 }}>
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
          Profile: <b>{ai.name}</b> · keys in OS keychain ·{" "}
          <button
            className="chip"
            style={{ padding: "2px 8px", fontSize: 11 }}
            onClick={() => { setView("settings"); setModelPicker(false); }}
          >
            Configure
          </button>
        </div>
      </motion.div>
    </>
  );
}

function cap(s: string) {
  return s[0].toUpperCase() + s.slice(1);
}
