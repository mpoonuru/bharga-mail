import { useState } from "react";
import { useApp } from "@/store";
import { api } from "@/lib/bridge";
import { AccountForm } from "@/components/AccountForm";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/icons";
import { SignatureManager } from "@/components/SignatureManager";
import { FONTS, LOCALES } from "@/lib/prefs";
import type { AiRole } from "@/types";

const field: React.CSSProperties = {
  flex: 1,
  minWidth: 160,
  border: "1px solid var(--border-2)",
  background: "var(--bg-2)",
  color: "var(--text)",
  fontFamily: "var(--font)",
  fontSize: 12.5,
  padding: "7px 10px",
  borderRadius: 8,
  outline: "none",
};

const ROLES: { id: AiRole; label: string; hint: string }[] = [
  { id: "triage", label: "Triage & labeling", hint: "runs on every email — cheap, private" },
  { id: "embeddings", label: "Search / embeddings", hint: "high volume, privacy-sensitive" },
  { id: "summarize", label: "Summaries", hint: "balance cost & quality" },
  { id: "draft", label: "Drafts & rewrite", hint: "quality matters most here" },
  { id: "agent", label: "Agent / tool-use", hint: "needs function calling" },
];

export function Settings() {
  const { ai, density, setDensity, theme, toggleTheme, assignRole, setPrivacy, updateModel, addModel, saveAi, connectGmail, connectMicrosoft, font, locale, setFont, setLocale, groupConversations, setGroupConversations, highlights, setHighlights, autoOrganize, setAutoOrganize, accounts, load, removeAccount } = useApp();
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [editAccount, setEditAccount] = useState<{ id: string; initial: Partial<import("@/lib/bridge").ImapAccountInput> } | null>(null);

  async function openEdit(id: string) {
    const initial = await api.getImapAccount(id);
    if (initial) setEditAccount({ id, initial });
  }
  async function confirmRemove(id: string, email: string) {
    if (!window.confirm(`Remove ${email}? This deletes its locally-synced mail and saved credentials.`)) return;
    await removeAccount(id);
    setAcctStatus(`Removed ${email}.`);
  }

  async function syncAccount(id: string) {
    setSyncingId(id);
    setAcctStatus("Syncing…");
    try {
      const n = await api.syncNow(id, groupConversations);
      await load();
      setAcctStatus(`Synced ${n} message${n === 1 ? "" : "s"}.`);
    } catch (e) {
      setAcctStatus(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncingId(null);
    }
  }
  const [saved, setSaved] = useState(false);
  const [savingEngine, setSavingEngine] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [acctStatus, setAcctStatus] = useState("");

  async function save() {
    setSavingEngine(true);
    await saveAi();
    setSavingEngine(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
  }

  async function addGmail() {
    setAcctStatus("Opening Google sign-in…");
    try {
      const id = await connectGmail();
      setAcctStatus(`Connected ${id} — synced.`);
    } catch {
      setAcctStatus("Connecting accounts requires the desktop app (bun run tauri:dev) with AETHER_GMAIL_CLIENT_ID set.");
    }
  }

  async function addMicrosoft() {
    setAcctStatus("Opening Microsoft sign-in…");
    try {
      const id = await connectMicrosoft();
      setAcctStatus(`Connected ${id} — synced.`);
    } catch {
      setAcctStatus("Connecting Microsoft 365 requires the desktop app (bun run tauri:dev) with AETHER_MS_CLIENT_ID set.");
    }
  }

  const [imapOpen, setImapOpen] = useState(false);

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
          <div className="info" style={{ marginBottom: 12 }}>
            <b>Models</b>
            <p>Bring your own: cloud APIs, any OpenAI-compatible endpoint, or a local model. Keys live in the OS keychain.</p>
          </div>
          {ai?.models.map((m) => {
            const needsKey = m.kind === "anthropic" || m.kind === "openai-compatible" || m.kind === "google";
            return (
              <div key={m.id} style={{ padding: "12px 0", borderBottom: "1px solid var(--border)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span className="dot" style={{ background: m.ready ? "var(--good)" : "var(--text-3)", boxShadow: m.ready ? undefined : "none" }} />
                  <b style={{ fontSize: 13, minWidth: 150 }}>{m.label}</b>
                  <span className="tag ai" style={{ textTransform: "none" }}>{m.kind}</span>
                  <span style={{ fontSize: 11, color: m.ready ? "var(--good)" : "var(--text-3)" }}>{m.ready ? "ready" : "not configured"}</span>
                </div>

                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <input
                    placeholder="model id (e.g. gpt-4o, llama3)"
                    defaultValue={m.model ?? ""}
                    onChange={(e) => updateModel(m.id, { model: e.target.value })}
                    style={field}
                  />
                  {needsKey ? (
                    <input
                      type="password"
                      placeholder="API key"
                      defaultValue={m.apiKey ?? ""}
                      onChange={(e) => updateModel(m.id, { apiKey: e.target.value })}
                      style={field}
                    />
                  ) : (
                    <input
                      placeholder="endpoint (e.g. http://localhost:11434)"
                      defaultValue={m.endpoint ?? ""}
                      onChange={(e) => updateModel(m.id, { endpoint: e.target.value })}
                      style={field}
                    />
                  )}
                </div>

                <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                  {ROLES.map((r) => (
                    <button
                      key={r.id}
                      className={`chip${m.roles.includes(r.id) ? " solid" : ""}`}
                      title={r.hint}
                      onClick={() => assignRole(m.id, r.id)}
                      disabled={!m.ready}
                      style={{ opacity: m.ready ? 1 : 0.4 }}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
            <button className="af-btn ghost" onClick={addModel}><Icon name="plus" size={14} /> Add provider</button>
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

      <p className="sub" style={{ fontWeight: 600, color: "var(--text-2)", marginBottom: 8 }}>Signatures</p>
      <div className="card">
        <div className="setting-row" style={{ display: "block" }}>
          <div className="info" style={{ marginBottom: 10 }}><b>Email signatures</b><p>Add multiple rich-text signatures; the default is appended to new messages and replies.</p></div>
          <SignatureManager />
        </div>
      </div>

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

      <p className="sub" style={{ fontWeight: 600, color: "var(--text-2)", marginBottom: 8 }}>Accounts</p>
      <div className="card">
        {accounts.length === 0 && (
          <div className="setting-row"><div className="info"><b>No account connected</b><p>Add one below to start syncing mail.</p></div></div>
        )}
        {accounts.map((a) => (
          <div className="setting-row" key={a.id}>
            <div className="info">
              <b>{a.email}</b>
              <p>{a.provider.toUpperCase()}{a.unread ? ` · ${a.unread} unread` : ""}</p>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button className="af-btn ghost" disabled={syncingId === a.id} onClick={() => syncAccount(a.id)}>
                <Icon name="ai" size={14} /> {syncingId === a.id ? "Syncing…" : "Sync"}
              </button>
              {a.provider === "imap" && (
                <button className="af-btn ghost" onClick={() => openEdit(a.id)}><Icon name="compose" size={14} /> Edit</button>
              )}
              <button className="af-btn ghost" onClick={() => confirmRemove(a.id, a.email)}><Icon name="close" size={14} /> Remove</button>
            </div>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
          <button className="af-btn ghost" onClick={addGmail}><Icon name="cloud" size={14} /> Connect Gmail</button>
          <button className="af-btn ghost" onClick={addMicrosoft}><Icon name="cloud" size={14} /> Microsoft 365</button>
          <button className="af-btn ghost" onClick={() => setImapOpen((v) => !v)}><Icon name="server" size={14} /> IMAP / SMTP</button>
        </div>

        <Modal open={imapOpen} onClose={() => setImapOpen(false)} title="Add IMAP / SMTP account">
          <AccountForm onClose={() => setImapOpen(false)} onStatus={setAcctStatus} />
        </Modal>
        <Modal open={!!editAccount} onClose={() => setEditAccount(null)} title="Edit account">
          {editAccount && (
            <AccountForm
              editing
              initial={editAccount.initial}
              onClose={() => setEditAccount(null)}
              onStatus={setAcctStatus}
            />
          )}
        </Modal>
        {acctStatus && <p className="sub" style={{ marginTop: 10 }}>{acctStatus}</p>}
      </div>

      <p className="sub" style={{ fontWeight: 600, color: "var(--text-2)", marginBottom: 8, marginTop: 18 }}>About</p>
      <div className="card">
        <div className="setting-row">
          <div className="info"><b>Aether Mail</b><p>AI-native email client — your mail, your model, your machine. Version 0.1.0.</p></div>
        </div>
        <div className="setting-row">
          <div className="info"><b>Built by</b><p>Arjun P</p></div>
        </div>
      </div>
    </>
  );
}
