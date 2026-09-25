import { useEffect, useState } from "react";
import { api, runtimeMode } from "@/lib/bridge";
import { AboutSettings } from "@/components/settings/AboutSettings";
import { AccountSettings } from "@/components/settings/AccountSettings";
import { AiPrivacySettings } from "@/components/settings/AiPrivacySettings";
import { AppearanceSettings } from "@/components/settings/AppearanceSettings";
import { DiagnosticsSettings } from "@/components/settings/DiagnosticsSettings";
import { SecurityDataSettings } from "@/components/settings/SecurityDataSettings";
import { SignatureSettings } from "@/components/settings/SignatureSettings";
import { SettingsShell, type SettingsSection } from "@/components/settings/SettingsShell";

export function Settings() {
  const [appVersion, setAppVersion] = useState(__APP_VERSION__);
  const [activeSection, setActiveSection] = useState<SettingsSection>("accounts");

  useEffect(() => {
    let active = true;
    void api.getAppVersion().then((version) => { if (active) setAppVersion(version); });
    return () => { active = false; };
  }, []);

  return (
    <>
      <h1>Settings</h1>
      <p className="sub">Your mail, your model, your machine.</p>

      <SettingsShell active={activeSection} onChange={setActiveSection}>
        {activeSection === "accounts" && <AccountSettings runtime={runtimeMode()} />}
        {activeSection === "appearance" && <AppearanceSettings />}
        {activeSection === "ai-privacy" && <AiPrivacySettings />}
        {activeSection === "signatures" && <SignatureSettings />}
        {activeSection === "security-data" && <SecurityDataSettings />}
        {activeSection === "diagnostics" && <DiagnosticsSettings version={appVersion} runtime={runtimeMode()} />}
        {activeSection === "about" && <AboutSettings version={appVersion} runtime={runtimeMode()} />}
      </SettingsShell>
    </>
  );
}
