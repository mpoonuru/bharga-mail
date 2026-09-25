// User-triggered, strictly redacted support export with local success and failure feedback.
import { useState } from "react";

import { Icon } from "@/components/icons";
import { buildRedactedDiagnostics, serializeDiagnostics } from "@/lib/diagnostics";
import { useApp } from "@/store";

interface DiagnosticsSettingsProps {
  version: string;
  runtime: "desktop" | "preview";
}

export function DiagnosticsSettings({ version, runtime }: DiagnosticsSettingsProps) {
  const { accounts, ai, theme, density, font, locale, threads, tasks } = useApp();
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const snapshot = buildRedactedDiagnostics({
    version,
    runtime,
    accounts,
    models: ai?.models ?? [],
    preferences: { theme, density, font, locale },
    threadCount: threads.length,
    taskCount: tasks.length,
  });
  const serialized = serializeDiagnostics(snapshot);

  async function copy() {
    setFeedback(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(serialized);
      setFeedback({ tone: "success", text: "Copied redacted diagnostics. No account identities or message content were included." });
    } catch (cause) {
      setFeedback({ tone: "error", text: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  function download() {
    setFeedback(null);
    try {
      const url = URL.createObjectURL(new Blob([serialized], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "bharga-diagnostics.json";
      anchor.click();
      URL.revokeObjectURL(url);
      setFeedback({ tone: "success", text: "Redacted diagnostics downloaded." });
    } catch (cause) {
      setFeedback({ tone: "error", text: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  return (
    <div className="settings-section diagnostics-settings">
      <div className="settings-section-head">
        <div>
          <h2>Diagnostics</h2>
          <p className="sub">Share app health without exposing addresses, names, provider labels, endpoints, credentials, or message content.</p>
        </div>
        {runtime === "preview" && <span className="tag">Preview runtime</span>}
      </div>
      <div className="diagnostics-summary" aria-label="Diagnostics summary">
        <div><span>Accounts</span><b>{snapshot.accounts.total}</b><small>{snapshot.accounts.synced} synced</small></div>
        <div><span>AI providers</span><b>{snapshot.ai.providers}</b><small>{snapshot.ai.ready} ready</small></div>
        <div><span>Local threads</span><b>{snapshot.localData.threads}</b><small>{snapshot.localData.tasks} tasks</small></div>
        <div><span>Runtime</span><b>{runtime === "desktop" ? "Desktop" : "Preview"}</b><small>Version {version}</small></div>
      </div>
      <div className="settings-callout">The export is generated on demand and contains aggregate counts and non-identifying preference values only.</div>
      <div className="diagnostics-actions">
        <button type="button" className="af-btn primary" onClick={() => void copy()}><Icon name="copy" size={14} /> Copy redacted diagnostics</button>
        <button type="button" className="af-btn ghost" onClick={download}><Icon name="tasks" size={14} /> Download JSON</button>
      </div>
      {feedback && <div className={`settings-alert ${feedback.tone === "error" ? "error" : ""}`} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}</div>}
    </div>
  );
}
