// Focused presentation and reading preferences, separate from account and AI operations.
import { Icon } from "@/components/icons";
import { Select } from "@/components/ui/Select";
import { FONTS, LOCALES } from "@/lib/prefs";
import { useApp } from "@/store";

export function AppearanceSettings() {
  const {
    density,
    setDensity,
    theme,
    toggleTheme,
    font,
    locale,
    setFont,
    setLocale,
    groupConversations,
    setGroupConversations,
    highlights,
    setHighlights,
  } = useApp();

  return (
    <div className="settings-section">
      <h2>Appearance</h2>
      <p className="sub">Tune how Bharga Mail looks and how conversations are presented.</p>
      <div className="settings-group">
        <div className="settings-row">
          <div><b>Theme</b><p>Use a light or dark workspace.</p></div>
          <button type="button" className="af-btn ghost" onClick={toggleTheme}><Icon name={theme === "dark" ? "sun" : "moon"} size={14} /> {theme === "dark" ? "Use light" : "Use dark"}</button>
        </div>
        <div className="settings-row">
          <div><b>Density</b><p>Choose how much information each list shows.</p></div>
          <div className="seg" role="radiogroup" aria-label="Interface density">
            {(["compact", "cozy", "comfy"] as const).map((value) => (
              <button key={value} type="button" role="radio" aria-checked={density === value} className={density === value ? "on" : ""} onClick={() => setDensity(value)}>
                {value[0].toUpperCase() + value.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <div><b>Interface font</b><p>Bundled variable fonts or the system font.</p></div>
          <div className="settings-control"><Select id="settings-font" fullWidth value={font} options={FONTS.map((option) => ({ value: option.value, label: option.label }))} onChange={setFont} /></div>
        </div>
        <div className="settings-row">
          <div><b>Language and formats</b><p>Controls date and number formatting.</p></div>
          <div className="settings-control"><Select id="settings-locale" fullWidth value={locale} options={LOCALES} onChange={setLocale} /></div>
        </div>
        <div className="settings-row">
          <div><b>Group into conversations</b><p>Thread IMAP replies together on the next sync.</p></div>
          <BinaryChoice label="Group into conversations" value={groupConversations} onChange={setGroupConversations} />
        </div>
        <div className="settings-row">
          <div><b>Smart highlights</b><p>Highlight dates, amounts, percentages, and urgency in mail.</p></div>
          <BinaryChoice label="Smart highlights" value={highlights} onChange={setHighlights} />
        </div>
      </div>
    </div>
  );
}

function BinaryChoice({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      <button type="button" role="radio" aria-checked={value} className={value ? "on" : ""} onClick={() => onChange(true)}>On</button>
      <button type="button" role="radio" aria-checked={!value} className={!value ? "on" : ""} onClick={() => onChange(false)}>Off</button>
    </div>
  );
}
