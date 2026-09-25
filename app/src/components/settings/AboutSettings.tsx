// About metadata stays derived from runtime/package state and neutral for open source.
interface AboutSettingsProps {
  version: string;
  runtime: "desktop" | "preview";
}

export function AboutSettings({ version, runtime }: AboutSettingsProps) {
  return (
    <div className="settings-section about-settings">
      <div className="settings-section-head">
        <div>
          <h2>About</h2>
          <p className="sub">Bharga Mail is an open-source, local-first desktop mail client.</p>
        </div>
        {runtime === "preview" && <span className="tag">Preview runtime</span>}
      </div>
      <div className="settings-group">
        <div className="settings-row">
          <div><b>Bharga Mail</b><p>Your mail, your model, your machine.</p></div>
          <span className="about-version">Version {version}</span>
        </div>
        <div className="settings-row">
          <div><b>Maintained by</b><p>Bharga Mail contributors</p></div>
        </div>
      </div>
    </div>
  );
}
