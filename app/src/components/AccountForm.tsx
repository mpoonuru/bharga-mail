import { useId, useState } from "react";
import { api } from "@/lib/bridge";
import { useApp } from "@/store";
import { Checkbox } from "@/components/ui/Checkbox";
import { Select } from "@/components/ui/Select";
import { Icon } from "@/components/icons";

type Sec = "ssl" | "starttls" | "none";

const SECURITY: { value: Sec; label: string }[] = [
  { value: "ssl", label: "SSL/TLS" },
  { value: "starttls", label: "STARTTLS" },
  { value: "none", label: "None" },
];

const portFor = (kind: "imap" | "smtp", sec: Sec) =>
  kind === "imap" ? (sec === "starttls" ? 143 : sec === "none" ? 143 : 993) : sec === "ssl" ? 465 : 587;

interface AccountFormProps {
  onClose: () => void;
  onStatus: (s: string) => void;
  /** Pre-filled settings when editing an existing account (no password). */
  initial?: Partial<{
    email: string; displayName: string;
    imapHost: string; imapPort: number; imapSecurity: Sec; imapUsername: string;
    smtpHost: string; smtpPort: number; smtpSecurity: Sec; smtpUsername: string;
  }>;
  editing?: boolean;
}

export function AccountForm({ onClose, onStatus, initial, editing = false }: AccountFormProps) {
  const load = useApp((s) => s.load);
  const formId = useId();
  const fieldId = (name: string) => `${formId}-${name}`;
  const [step, setStep] = useState<"details" | "servers">("details");
  const [f, setF] = useState({
    email: initial?.email ?? "",
    displayName: initial?.displayName ?? "",
    imapHost: initial?.imapHost ?? "",
    imapPort: initial?.imapPort ?? 993,
    imapSecurity: (initial?.imapSecurity ?? "ssl") as Sec,
    imapUsername: initial?.imapUsername ?? "",
    imapPassword: "",
    smtpHost: initial?.smtpHost ?? "",
    smtpPort: initial?.smtpPort ?? 465,
    smtpSecurity: (initial?.smtpSecurity ?? "ssl") as Sec,
    smtpUsername: initial?.smtpUsername ?? "",
    smtpPassword: "",
  });
  // If the saved SMTP username differs from IMAP, the account uses separate creds.
  const [sameCreds, setSameCreds] = useState(
    !initial || !initial.smtpUsername || initial.smtpUsername === initial.imapUsername
  );
  const [busy, setBusy] = useState<null | "test" | "save">(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (patch: Partial<typeof f>) => setF((p) => ({ ...p, ...patch }));

  // When editing, the password may be left blank to keep the existing one.
  const validIdentity = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim());
  const valid = validIdentity && !!f.imapHost.trim() && !!f.smtpHost.trim() && (editing || !!f.imapPassword);
  const payload = () => ({
    email: f.email,
    displayName: f.displayName || undefined,
    imapHost: f.imapHost,
    imapPort: f.imapPort,
    imapSecurity: f.imapSecurity,
    imapUsername: f.imapUsername || undefined,
    imapPassword: f.imapPassword,
    smtpHost: f.smtpHost,
    smtpPort: f.smtpPort,
    smtpSecurity: f.smtpSecurity,
    smtpUsername: sameCreds ? undefined : f.smtpUsername || undefined,
    smtpPassword: sameCreds ? undefined : f.smtpPassword || undefined,
  });
  const errText = (e: unknown) => (typeof e === "string" ? e : (e as Error)?.message ?? String(e));

  async function test() {
    if (!valid || busy) return;
    setBusy("test");
    setStatus({ ok: true, text: "Testing connection…" });
    try {
      const msg = await api.testImapAccount(payload());
      setStatus({ ok: true, text: msg });
    } catch (e) {
      setStatus({ ok: false, text: errText(e) });
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!valid || busy) return;
    setBusy("save");
    setStatus({ ok: true, text: "Connecting and fetching inbox…" });
    try {
      const id = await api.saveImapAccount(payload());
      const n = await api.syncNow(id, useApp.getState().groupConversations);
      await api.listFolders(id); // enumerate mailboxes so the sidebar folder list populates
      await load();
      onStatus(`Connected ${f.email} — ${n} message${n === 1 ? "" : "s"} synced.`);
      onClose();
    } catch (e) {
      setStatus({ ok: false, text: `Couldn't connect: ${errText(e)}` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="acct-form">
      <div className="af-progress" aria-label="Account setup progress">
        <span className={step === "details" ? "active" : "complete"}>1 <b>Account</b></span>
        <span className={step === "servers" ? "active" : ""}>2 <b>Servers</b></span>
      </div>

      {step === "details" ? (
        <div className="af-grid">
          <Field label="Email address" htmlFor={fieldId("email")} full>
            <input id={fieldId("email")} aria-label="Email address" className="af-input" type="email" autoComplete="email" placeholder="you@example.com" value={f.email}
              onChange={(e) => set({ email: e.target.value })} />
          </Field>
          <Field label="Display name (optional)" htmlFor={fieldId("display-name")} full>
            <input id={fieldId("display-name")} aria-label="Display name" className="af-input" autoComplete="name" placeholder="Your name" value={f.displayName}
              onChange={(e) => set({ displayName: e.target.value })} />
          </Field>
          <p className="af-privacy af-full">Credentials stay on this device and are protected by the operating system keychain.</p>
        </div>
      ) : (
        <>
          <div className="af-section">Incoming mail · IMAP</div>
          <div className="af-grid">
            <Field label="IMAP host" htmlFor={fieldId("imap-host")}><input id={fieldId("imap-host")} aria-label="IMAP host" className="af-input" placeholder="imap.example.com" value={f.imapHost} onChange={(e) => set({ imapHost: e.target.value })} /></Field>
            <Field label="Port" htmlFor={fieldId("imap-port")}><input id={fieldId("imap-port")} aria-label="IMAP port" className="af-input" type="number" value={f.imapPort} onChange={(e) => set({ imapPort: Number(e.target.value) })} /></Field>
            <Field label="Security" htmlFor={fieldId("imap-security")}>
              <Select id={fieldId("imap-security")} fullWidth value={f.imapSecurity} options={SECURITY} onChange={(v) => { const s = v as Sec; set({ imapSecurity: s, imapPort: portFor("imap", s) }); }} />
            </Field>
            <Field label="Username (optional)" htmlFor={fieldId("imap-username")}><input id={fieldId("imap-username")} aria-label="IMAP username" className="af-input" autoComplete="username" placeholder="Defaults to email" value={f.imapUsername} onChange={(e) => set({ imapUsername: e.target.value })} /></Field>
            <Field label={editing ? "Password (leave blank to keep saved password)" : "Password"} htmlFor={fieldId("imap-password")} full><input id={fieldId("imap-password")} aria-label="IMAP password" className="af-input" type="password" autoComplete="current-password" value={f.imapPassword} onChange={(e) => set({ imapPassword: e.target.value })} /></Field>
          </div>

          <div className="af-section">Outgoing mail · SMTP</div>
          <div className="af-grid">
            <Field label="SMTP host" htmlFor={fieldId("smtp-host")}><input id={fieldId("smtp-host")} aria-label="SMTP host" className="af-input" placeholder="smtp.example.com" value={f.smtpHost} onChange={(e) => set({ smtpHost: e.target.value })} /></Field>
            <Field label="Port" htmlFor={fieldId("smtp-port")}><input id={fieldId("smtp-port")} aria-label="SMTP port" className="af-input" type="number" value={f.smtpPort} onChange={(e) => set({ smtpPort: Number(e.target.value) })} /></Field>
            <Field label="Security" htmlFor={fieldId("smtp-security")}>
              <Select id={fieldId("smtp-security")} fullWidth value={f.smtpSecurity} options={SECURITY} onChange={(v) => { const s = v as Sec; set({ smtpSecurity: s, smtpPort: portFor("smtp", s) }); }} />
            </Field>
          </div>
          <div className="mt-3">
            <Checkbox size="sm" checked={sameCreds} onChange={setSameCreds} label="Use the same username & password as incoming" />
          </div>
          {!sameCreds && (
            <div className="af-grid">
              <Field label="SMTP username" htmlFor={fieldId("smtp-username")}><input id={fieldId("smtp-username")} aria-label="SMTP username" className="af-input" autoComplete="username" value={f.smtpUsername} onChange={(e) => set({ smtpUsername: e.target.value })} /></Field>
              <Field label={editing ? "SMTP password (optional)" : "SMTP password"} htmlFor={fieldId("smtp-password")}><input id={fieldId("smtp-password")} aria-label="SMTP password" className="af-input" type="password" autoComplete="current-password" value={f.smtpPassword} onChange={(e) => set({ smtpPassword: e.target.value })} /></Field>
            </div>
          )}
        </>
      )}

      {status && (
        <div className={`af-status${status.ok ? "" : " err"}`}>
          <Icon name={busy ? "ai" : status.ok ? "tasks" : "close"} size={14} weight="duotone" />
          <span>{status.text}</span>
        </div>
      )}

      <div className="af-actions">
        {step === "servers" ? (
          <button className="af-btn ghost" onClick={test} disabled={!valid || !!busy}>
            <Icon name="plug" size={14} /> {busy === "test" ? "Testing…" : "Test connection"}
          </button>
        ) : <span />}
        <div className="af-actions-right">
          {step === "servers" && (
            <button className="af-btn ghost" onClick={() => setStep("details")} disabled={!!busy}>
              <Icon name="caretLeft" size={14} /> Back
            </button>
          )}
          <button className="af-btn ghost" onClick={onClose}><Icon name="close" size={14} /> Cancel</button>
          {step === "details" ? (
            <button className="af-btn primary" onClick={() => setStep("servers")} disabled={!validIdentity}>
              Continue <Icon name="caretRight" size={14} />
            </button>
          ) : (
            <button className="af-btn primary" onClick={save} disabled={!valid || !!busy}>
              <Icon name="send" size={14} weight="fill" /> {busy === "save" ? "Connecting…" : "Save & sync"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, htmlFor, full, children }: { label: string; htmlFor: string; full?: boolean; children: React.ReactNode }) {
  return (
    <div className={`af-field${full ? " af-full" : ""}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}
