import { useState } from "react";
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
  const valid = f.email.includes("@") && f.imapHost && f.smtpHost && (editing || !!f.imapPassword);
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
      <div className="af-grid">
        <Field label="Email address" full>
          <input className="af-input" type="email" placeholder="you@company.com" value={f.email}
            onChange={(e) => set({ email: e.target.value })} />
        </Field>
        <Field label="Display name (optional)" full>
          <input className="af-input" placeholder="Your Name" value={f.displayName}
            onChange={(e) => set({ displayName: e.target.value })} />
        </Field>
      </div>

      <div className="af-section">Incoming mail · IMAP</div>
      <div className="af-grid">
        <Field label="IMAP host"><input className="af-input" placeholder="imap.company.com" value={f.imapHost} onChange={(e) => set({ imapHost: e.target.value })} /></Field>
        <Field label="Port"><input className="af-input" type="number" value={f.imapPort} onChange={(e) => set({ imapPort: Number(e.target.value) })} /></Field>
        <Field label="Security">
          <Select fullWidth value={f.imapSecurity} options={SECURITY} onChange={(v) => { const s = v as Sec; set({ imapSecurity: s, imapPort: portFor("imap", s) }); }} />
        </Field>
        <Field label="Username (optional)"><input className="af-input" placeholder="defaults to email" value={f.imapUsername} onChange={(e) => set({ imapUsername: e.target.value })} /></Field>
        <Field label="Password" full><input className="af-input" type="password" value={f.imapPassword} onChange={(e) => set({ imapPassword: e.target.value })} /></Field>
      </div>

      <div className="af-section">Outgoing mail · SMTP</div>
      <div className="af-grid">
        <Field label="SMTP host"><input className="af-input" placeholder="smtp.company.com" value={f.smtpHost} onChange={(e) => set({ smtpHost: e.target.value })} /></Field>
        <Field label="Port"><input className="af-input" type="number" value={f.smtpPort} onChange={(e) => set({ smtpPort: Number(e.target.value) })} /></Field>
        <Field label="Security">
          <Select fullWidth value={f.smtpSecurity} options={SECURITY} onChange={(v) => { const s = v as Sec; set({ smtpSecurity: s, smtpPort: portFor("smtp", s) }); }} />
        </Field>
      </div>
      <div className="mt-3">
        <Checkbox size="sm" checked={sameCreds} onChange={setSameCreds} label="Use the same username & password as incoming" />
      </div>
      {!sameCreds && (
        <div className="af-grid">
          <Field label="SMTP username"><input className="af-input" value={f.smtpUsername} onChange={(e) => set({ smtpUsername: e.target.value })} /></Field>
          <Field label="SMTP password"><input className="af-input" type="password" value={f.smtpPassword} onChange={(e) => set({ smtpPassword: e.target.value })} /></Field>
        </div>
      )}

      {status && (
        <div className={`af-status${status.ok ? "" : " err"}`}>
          <Icon name={busy ? "ai" : status.ok ? "tasks" : "close"} size={14} weight="duotone" />
          <span>{status.text}</span>
        </div>
      )}

      <div className="af-actions">
        <button className="af-btn ghost" onClick={test} disabled={!valid || !!busy}>
          <Icon name="plug" size={14} /> {busy === "test" ? "Testing…" : "Test connection"}
        </button>
        <div className="af-actions-right">
          <button className="af-btn ghost" onClick={onClose}><Icon name="close" size={14} /> Cancel</button>
          <button className="af-btn primary" onClick={save} disabled={!valid || !!busy}>
            <Icon name="send" size={14} weight="fill" /> {busy === "save" ? "Connecting…" : "Save & sync"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return (
    <div className={`af-field${full ? " af-full" : ""}`}>
      <label>{label}</label>
      {children}
    </div>
  );
}
