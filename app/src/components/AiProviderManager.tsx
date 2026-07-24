import { useEffect, useState } from "react";

import { Icon } from "@/components/icons";
import { api } from "@/lib/bridge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useApp } from "@/store";
import type { AiModel, AiRole, SaveAiProviderInput } from "@/types";

const ROLES: { id: AiRole; label: string; hint: string }[] = [
  { id: "triage", label: "Triage & labeling", hint: "Runs for inbox organization" },
  { id: "embeddings", label: "Search / embeddings", hint: "Builds semantic search" },
  { id: "summarize", label: "Summaries", hint: "Summarizes conversations" },
  { id: "draft", label: "Drafts & rewrite", hint: "Writes and rewrites mail" },
  { id: "agent", label: "Agent / tool-use", hint: "Uses connected tools" },
];

interface Draft {
  label: string;
  model: string;
  endpoint: string;
  apiKey: string;
  roles: AiRole[];
}

function draftFor(model: AiModel): Draft {
  return {
    label: model.label,
    model: model.model ?? "",
    endpoint: model.endpoint ?? "",
    apiKey: "",
    roles: [...model.roles],
  };
}

export function AiProviderManager() {
  const { ai, addModel, saveModel, removeModel } = useApp();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<AiModel | null>(null);
  const [message, setMessage] = useState<{ id: string; tone: "error" | "success"; text: string } | null>(null);

  useEffect(() => {
    if (!ai) return;
    setDrafts((current) => Object.fromEntries(ai.models.map((model) => [
      model.id,
      current[model.id] ?? draftFor(model),
    ])));
  }, [ai]);

  function patch(id: string, value: Partial<Draft>) {
    setDrafts((current) => ({ ...current, [id]: { ...current[id], ...value } }));
  }

  function toggleRole(id: string, role: AiRole) {
    const draft = drafts[id];
    if (!draft) return;
    patch(id, {
      roles: draft.roles.includes(role)
        ? draft.roles.filter((candidate) => candidate !== role)
        : [...draft.roles, role],
    });
  }

  async function save(model: AiModel) {
    const draft = drafts[model.id];
    if (!draft) return;
    setBusyId(model.id);
    setMessage(null);
    const input: SaveAiProviderInput = {
      ...model,
      label: draft.label,
      model: draft.model,
      endpoint: draft.endpoint,
      roles: draft.roles,
      apiKey: draft.apiKey || undefined,
    };
    try {
      await saveModel(input);
      patch(model.id, { apiKey: "" });
      setMessage({ id: model.id, tone: "success", text: "Provider saved securely." });
    } catch (error) {
      setMessage({
        id: model.id,
        tone: "error",
        text: error instanceof Error ? error.message : "Provider could not be saved.",
      });
    } finally {
      setBusyId(null);
    }
  }

  async function testConnection(model: AiModel) {
    const draft = drafts[model.id];
    if (!draft) return;
    setBusyId(model.id);
    setMessage(null);
    try {
      const text = await api.testAiProvider({
        ...model,
        label: draft.label,
        model: draft.model,
        endpoint: draft.endpoint,
        roles: draft.roles,
        apiKey: draft.apiKey || undefined,
      });
      setMessage({ id: model.id, tone: "success", text });
    } catch (error) {
      setMessage({
        id: model.id,
        tone: "error",
        text: error instanceof Error ? error.message : "Connection test failed.",
      });
    } finally {
      setBusyId(null);
    }
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    const id = removeTarget.id;
    setBusyId(id);
    setMessage(null);
    try {
      await removeModel(id);
      setRemoveTarget(null);
    } catch (error) {
      setRemoveTarget(null);
      setMessage({
        id,
        tone: "error",
        text: error instanceof Error ? error.message : "Provider could not be removed.",
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="provider-manager">
      <div className="provider-manager-head">
        <div>
          <b>AI providers</b>
          <p>Credentials stay in your OS keychain and are never shown again after saving.</p>
        </div>
        <button className="af-btn ghost" onClick={addModel}>
          <Icon name="plus" size={14} /> Add provider
        </button>
      </div>

      <div className="provider-list">
        {ai?.models.map((model) => {
          const draft = drafts[model.id] ?? draftFor(model);
          const keyBased = model.kind !== "local";
          const configurableEndpoint = model.kind === "openai-compatible" || model.kind === "custom" || model.kind === "local";
          return (
            <section className="provider-card" key={model.id}>
              <div className="provider-card-head">
                <span className={`provider-state ${model.ready ? "ready" : ""}`} aria-hidden="true" />
                <div className="provider-identity">
                  <input
                    aria-label="Provider name"
                    value={draft.label}
                    onChange={(event) => patch(model.id, { label: event.target.value })}
                  />
                  <span>{model.kind}</span>
                </div>
                <span className={`provider-status ${model.ready ? "ready" : ""}`}>
                  {model.ready ? "Configured" : "Needs setup"}
                </span>
                <button
                  className="provider-remove"
                  onClick={() => setRemoveTarget(model)}
                  title={`Remove ${model.label}`}
                  aria-label={`Remove ${model.label}`}
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>

              <div className="provider-fields">
                <label>
                  <span>Model</span>
                  <input
                    value={draft.model}
                    placeholder="Model identifier"
                    onChange={(event) => patch(model.id, { model: event.target.value })}
                  />
                </label>
                {configurableEndpoint && (
                  <label>
                    <span>Endpoint</span>
                    <input
                      value={draft.endpoint}
                      placeholder={model.kind === "local" ? "http://localhost:11434" : "https://api.example.com/v1"}
                      onChange={(event) => patch(model.id, { endpoint: event.target.value })}
                    />
                  </label>
                )}
                {keyBased && (
                  <label>
                    <span>API key</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={draft.apiKey}
                      placeholder={model.ready ? "Stored securely — enter only to replace" : "Enter API key"}
                      onChange={(event) => patch(model.id, { apiKey: event.target.value })}
                    />
                  </label>
                )}
              </div>

              <div className="provider-roles" aria-label={`Roles assigned to ${model.label}`}>
                {ROLES.map((role) => (
                  <button
                    key={role.id}
                    className={draft.roles.includes(role.id) ? "selected" : ""}
                    title={role.hint}
                    onClick={() => toggleRole(model.id, role.id)}
                    type="button"
                  >
                    {role.label}
                  </button>
                ))}
              </div>

              <div className="provider-card-foot">
                {message?.id === model.id && (
                  <p className={`provider-message ${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>
                    {message.text}
                  </p>
                )}
                <Button variant="ghost" onClick={() => void testConnection(model)} disabled={busyId === model.id}>
                  Test connection
                </Button>
                <Button onClick={() => void save(model)} loading={busyId === model.id}>
                  Save changes
                </Button>
              </div>
            </section>
          );
        })}
      </div>

      <Modal open={!!removeTarget} onClose={() => setRemoveTarget(null)} title="Remove AI provider" maxWidth={480}>
        <div className="provider-confirm">
          <p>
            Remove <b>{removeTarget?.label}</b>? Its saved credential will be permanently deleted from this device.
          </p>
          {!!removeTarget?.roles.length && (
            <p className="provider-impact">
              These roles will become unassigned: {removeTarget.roles.map((role) => role.replace("-", " ")).join(", ")}.
            </p>
          )}
          <div className="af-actions">
            <Button variant="ghost" onClick={() => setRemoveTarget(null)}>Cancel</Button>
            <button className="af-btn danger" onClick={() => void confirmRemove()} disabled={busyId === removeTarget?.id}>
              <Icon name="trash" size={14} /> Remove provider
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
