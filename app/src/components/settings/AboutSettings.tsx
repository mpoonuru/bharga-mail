// About metadata stays derived from runtime/package state and neutral for open source.
interface AboutSettingsProps {
  version: string;
  runtime: "desktop" | "preview";
}

export function AboutSettings({ version, runtime }: AboutSettingsProps) {
  return (
    <>
      <p className="sub" style={{ fontWeight: 600, color: "var(--text-2)", marginBottom: 8, marginTop: 18 }}>About</p>
      <div className="card">
        <div className="setting-row">
          <div className="info">
            <b>Bharga Mail</b>
            <p>AI-native email client — your mail, your model, your machine. Version {version}.</p>
          </div>
          {runtime === "preview" && <span className="tag">Preview runtime</span>}
        </div>
        <div className="setting-row">
          <div className="info"><b>Maintained by</b><p>Bharga Mail contributors</p></div>
        </div>
      </div>
    </>
  );
}
