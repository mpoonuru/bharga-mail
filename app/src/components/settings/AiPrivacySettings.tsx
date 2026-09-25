// Privacy-first AI settings with immediate persistence and scoped operational feedback.
import { useState } from "react";

import { AiProviderManager } from "@/components/AiProviderManager";
import { Icon } from "@/components/icons";
import { api } from "@/lib/bridge";
import { useApp } from "@/store";
import type { AiProfile } from "@/types";

const PRIVACY_OPTIONS: ReadonlyArray<{
  id: AiProfile["privacy"];
  label: string;
  description: string;
}> = [
  { id: "cloud", label: "Cloud", description: "Use configured cloud providers for AI features." },
  { id: "hybrid", label: "Hybrid", description: "Prefer role assignments across local and cloud providers." },
  { id: "local", label: "Local", description: "Keep AI processing on explicitly configured local endpoints." },
];

export function AiPrivacySettings() {
  const ai = useApp((state) => state.ai);
  const savePrivacy = useApp((state) => state.savePrivacy);
  const [privacyError, setPrivacyError] = useState("");
  const [savingPrivacy, setSavingPrivacy] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [indexStatus, setIndexStatus] = useState("");

  async function choosePrivacy(privacy: AiProfile["privacy"]) {
    if (!ai || privacy === ai.privacy || savingPrivacy) return;
    setPrivacyError("");
    setSavingPrivacy(true);
    try {
      await savePrivacy(privacy);
    } catch (cause) {
      setPrivacyError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingPrivacy(false);
    }
  }

  async function buildIndex() {
    if (indexing) return;
    setIndexing(true);
    setIndexStatus("Embedding mail on this device…");
    try {
      const count = await api.reindex();
      setIndexStatus(count > 0 ? `Indexed ${count} thread${count === 1 ? "" : "s"}.` : "Assign an embeddings model before building the index.");
    } catch (cause) {
      setIndexStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIndexing(false);
    }
  }

  return (
    <div className="settings-section ai-privacy-settings">
      <h2>AI and privacy</h2>
      <p className="sub">Choose where AI work happens, then assign providers to specific roles.</p>

      <section className="settings-block" aria-labelledby="privacy-mode-title">
        <div className="settings-block-head">
          <div>
            <h3 id="privacy-mode-title">Privacy mode</h3>
            <p>Changes save immediately. A mode never invents or redirects provider endpoints.</p>
          </div>
          {savingPrivacy && <span className="settings-saving" role="status">Saving…</span>}
        </div>
        <div className="privacy-options" role="radiogroup" aria-label="Privacy mode">
          {PRIVACY_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-label={option.label}
              aria-checked={ai?.privacy === option.id}
              disabled={!ai || savingPrivacy}
              onClick={() => void choosePrivacy(option.id)}
            >
              <span className="privacy-radio" aria-hidden="true" />
              <span><b>{option.label}</b><small>{option.description}</small></span>
            </button>
          ))}
        </div>
        {privacyError && <div className="settings-alert error" role="alert">{privacyError}</div>}
      </section>

      <section className="settings-block" aria-label="AI providers">
        <AiProviderManager />
      </section>

      <section className="settings-block semantic-index">
        <div>
          <h3>Semantic search index</h3>
          <p>Embeds mail locally so inbox search can retrieve by meaning, not only keywords.</p>
          {indexStatus && <div className="index-status" role="status">{indexStatus}</div>}
        </div>
        <button type="button" className="af-btn ghost" onClick={() => void buildIndex()} disabled={indexing}>
          <Icon name="ai" size={14} /> {indexing ? "Indexing…" : "Build index"}
        </button>
      </section>
    </div>
  );
}
