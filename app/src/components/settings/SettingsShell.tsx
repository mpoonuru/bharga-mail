// Stable settings information architecture and keyboard-complete destination navigation.
import { useRef, type KeyboardEvent, type ReactNode } from "react";

import { Icon, type IconName } from "@/components/icons";

export type SettingsSection =
  | "accounts"
  | "appearance"
  | "ai-privacy"
  | "signatures"
  | "security-data"
  | "diagnostics"
  | "about";

export const SETTINGS_SECTIONS: ReadonlyArray<readonly [SettingsSection, string, IconName]> = [
  ["accounts", "Accounts", "inbox"],
  ["appearance", "Appearance", "sun"],
  ["ai-privacy", "AI and privacy", "ai"],
  ["signatures", "Signatures", "compose"],
  ["security-data", "Security and data", "shieldWarning"],
  ["diagnostics", "Diagnostics", "tasks"],
  ["about", "About", "settings"],
];

interface SettingsShellProps {
  active: SettingsSection;
  onChange: (section: SettingsSection) => void;
  children: ReactNode;
}

export function SettingsShell({ active, onChange, children }: SettingsShellProps) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function selectFromKeyboard(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | undefined;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (index + 1) % SETTINGS_SECTIONS.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = (index - 1 + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = SETTINGS_SECTIONS.length - 1;
    }

    if (nextIndex === undefined) return;
    event.preventDefault();
    onChange(SETTINGS_SECTIONS[nextIndex][0]);
    tabRefs.current[nextIndex]?.focus();
  }

  return (
    <div className="settings-layout">
      <nav className="settings-nav-wrap" aria-label="Settings">
        <div className="settings-nav" role="tablist" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map(([id, label, icon], index) => (
            <button
              key={id}
              ref={(element) => { tabRefs.current[index] = element; }}
              id={`settings-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={active === id}
              aria-controls="settings-panel"
              tabIndex={active === id ? 0 : -1}
              onClick={() => onChange(id)}
              onKeyDown={(event) => selectFromKeyboard(event, index)}
            >
              <Icon name={icon} size={16} />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </nav>
      <section
        id="settings-panel"
        className="settings-panel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${active}`}
        tabIndex={0}
      >
        {children}
      </section>
    </div>
  );
}
