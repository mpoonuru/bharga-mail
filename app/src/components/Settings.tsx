import { useEffect, useState } from "react";
import { useApp } from "@/store";
import { api, runtimeMode } from "@/lib/bridge";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/icons";
import { SignatureManager } from "@/components/SignatureManager";
import { AiProviderManager } from "@/components/AiProviderManager";
import { AboutSettings } from "@/components/settings/AboutSettings";
import { AccountSettings } from "@/components/settings/AccountSettings";
import { SettingsShell, type SettingsSection } from "@/components/settings/SettingsShell";
import { FONTS, LOCALES } from "@/lib/prefs";
export function Settings() {
  const { ai, density, setDensity, theme, toggleTheme, setPrivacy, saveAi, font, locale, setFont, setLocale, groupConversations, setGroupConversations, highlights, setHighlights, autoOrganize, setAutoOrganize } = useApp();
  const [appVersion, setAppVersion] = useState(__APP_VERSION__);
  const [activeSection, setActiveSection] = useState<SettingsSection>("accounts");

  useEffect(() => {
    let active = true;
    void api.getAppVersion().then((version) => { if (active) setAppVersion(version); });
    return () => { active = false; };
  }, []);

  const [saved, setSaved] = useState(false);
  const [savingEngine, setSavingEngine] = useState(false);
  const [indexing, setIndexing] = useState(false);

  async function save() {
    setSavingEngine(true);
    await saveAi();
    setSavingEngine(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
  }

  const [indexStatus, setIndexStatus] = useState("");
  async function buildIndex() {
    setIndexing(true);
    setIndexStatus("Embedding your mail…");
    const n = await api.reindex();
    setIndexing(false);
    setIndexStatus(n > 0 ? `Indexed ${n} threads for semantic search.` : "Assign an Embeddings-role model (e.g. local Llama) and run the desktop app.");
  }

  return (
    <>
      <h1>Settings</h1>
      <p className="sub">Your mail, your model, your machine.</p>

      <SettingsShell active={activeSection} onChange={setActiveSection}>

      {activeSection === "ai-privacy" && <>

      <p className="sub" style={{ fontWeight: 600, color: "var(--text-2)", marginBottom: 8 }}>AI engine — plug &amp; play</p>
      <div className="card">
        <div className="setting-row">
          <div className="info"><b>Privacy preset</b><p>Where AI runs by default. Per-role overrides below.</p></div>
          <div className="seg">
            {(["cloud", "hybrid", "local"] as const).map((p) => (
              <button key={p} className={ai?.privacy === p ? "on" : ""} onClick={() => setPrivacy(p)}>
                {p[0].toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="setting-row" style={{ display: "block" }}>
          <AiProviderManager />
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
            <div style={{ marginLeft: "auto" }}>
              <Button onClick={save} icon={saved ? "tasks" : "settings"} loading={savingEngine}>{savingEngine ? "Saving…" : saved ? "Saved" : "Save engine"}</Button>
            </div>
          </div>
        </div>

        <div className="setting-row">
          <div className="info"><b>Semantic search index</b><p>Embeds your mail locally so “Ask my inbox” retrieves by meaning, not just keywords.</p></div>
          <Button variant="ghost" onClick={buildIndex} icon="ai" loading={indexing}>{indexing ? "Indexing…" : "Build index"}</Button>
        </div>
        {indexStatus && <p className="sub" style={{ marginTop: 6 }}>{indexStatus}</p>}
      </div>
      </>}

      {activeSection === "signatures" && <>
      <p className="sub" style={{ fontWeight: 600, color: "var(--text-2)", marginBottom: 8 }}>Signatures</p>
      <div className="card">
        <div className="setting-row" style={{ display: "block" }}>
          <div className="info" style={{ marginBottom: 10 }}><b>Email signatures</b><p>Add multiple rich-text signatures; the default is appended to new messages and replies.</p></div>
          <SignatureManager />
        </div>
      </div>
      </>}

      {activeSection === "appearance" && <>
      <p className="sub" style={{ fontWeight: 600, color: "var(--text-2)", marginBottom: 8 }}>Appearance</p>
      <div className="card">
        <div className="setting-row">
          <div className="info"><b>Theme</b><p>Calm Command material system.</p></div>
          <button className="af-btn ghost" onClick={toggleTheme}><Icon name={theme === "dark" ? "sun" : "moon"} size={14} /> {theme === "dark" ? "Light" : "Dark"}</button>
        </div>
        <div className="setting-row">
          <div className="info"><b>Density</b><p>How tight the list feels.</p></div>
          <div className="seg">
            {(["compact", "cozy", "comfy"] as const).map((d) => (
              <button key={d} className={density === d ? "on" : ""} onClick={() => setDensity(d)}>
                {d[0].toUpperCase() + d.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <div className="info"><b>Font</b><p>Bundled variable fonts or your system font.</p></div>
          <div style={{ minWidth: 180 }}>
            <Select fullWidth value={font} options={FONTS.map((f) => ({ value: f.value, label: f.label }))} onChange={setFont} />
          </div>
        </div>
        <div className="setting-row">
          <div className="info"><b>Language &amp; formats</b><p>Drives date &amp; number formatting (e.g. 31.12.2026 vs 12/31/2026).</p></div>
          <div style={{ minWidth: 180 }}>
            <Select fullWidth value={locale} options={LOCALES} onChange={setLocale} />
          </div>
        </div>
        <div className="setting-row">
          <div className="info"><b>Group into conversations</b><p>Thread replies together (IMAP). Applies on the next sync.</p></div>
          <div className="seg">
            <button className={groupConversations ? "on" : ""} onClick={() => setGroupConversations(true)}>On</button>
            <button className={!groupConversations ? "on" : ""} onClick={() => setGroupConversations(false)}>Off</button>
          </div>
        </div>
        <div className="setting-row">
          <div className="info"><b>Smart highlights</b><p>Highlight dates, amounts, %, and urgency/sentiment in emails.</p></div>
          <div className="seg">
            <button className={highlights ? "on" : ""} onClick={() => setHighlights(true)}>On</button>
            <button className={!highlights ? "on" : ""} onClick={() => setHighlights(false)}>Off</button>
          </div>
        </div>
        <div className="setting-row">
          <div className="info"><b>Auto-organize new mail</b><p>Summarize &amp; prioritize incoming mail with AI on arrival. Needs a model assigned below; does nothing without one.</p></div>
          <div className="seg">
            <button className={autoOrganize ? "on" : ""} onClick={() => setAutoOrganize(true)}>On</button>
            <button className={!autoOrganize ? "on" : ""} onClick={() => setAutoOrganize(false)}>Off</button>
          </div>
        </div>
      </div>
      </>}

      {activeSection === "accounts" && <>
        <AccountSettings runtime={runtimeMode()} />
      </>}

      {activeSection === "security-data" && (
        <div className="settings-section">
          <h2>Security and data</h2>
          <p className="sub">Control local storage and protection for this device.</p>
          <div className="settings-empty">Security and storage controls are being organized here.</div>
        </div>
      )}

      {activeSection === "diagnostics" && (
        <div className="settings-section">
          <h2>Diagnostics</h2>
          <p className="sub">Inspect app health without exposing message content or credentials.</p>
          <div className="settings-empty">Runtime diagnostics are being organized here.</div>
        </div>
      )}

      {activeSection === "about" && <AboutSettings version={appVersion} runtime={runtimeMode()} />}
      </SettingsShell>
    </>
  );
}
