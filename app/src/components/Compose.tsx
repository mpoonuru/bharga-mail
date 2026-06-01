import { useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useApp } from "@/store";
import { api } from "@/lib/bridge";
import { IconButton } from "@/components/ui/IconButton";
import { Button } from "@/components/ui/Button";
import { RichText, type RichTextHandle } from "@/components/ui/RichText";
import { Attachments, type Attach } from "@/components/ui/Attachments";
import { SendLater } from "@/components/ui/SendLater";
import { RecipientChips, type Contact } from "@/components/ui/RecipientChips";
import { Select } from "@/components/ui/Select";

// Full-screen new-message composer (opened from the sidebar or the "C" hotkey).
export function Compose() {
  const setCompose = useApp((s) => s.setCompose);
  const queueSend = useApp((s) => s.queueSend);
  const accounts = useApp((s) => s.accounts);
  const selectedAccountId = useApp((s) => s.selectedAccountId);
  const threads = useApp((s) => s.threads);
  const defaultSig = useApp((s) => s.signatures.find((x) => x.id === s.defaultSignatureId));
  // "From" account — defaults to the focused account, else the first connected one.
  const [from, setFrom] = useState(selectedAccountId ?? accounts[0]?.id ?? "");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState("");
  const [files, setFiles] = useState<Attach[]>([]);
  const [busy, setBusy] = useState(false);
  const editorRef = useRef<RichTextHandle>(null);
  const initialHtml = defaultSig?.html ? `<p></p><p>--<br>${defaultSig.html}</p>` : "";

  // Autocomplete contacts: every distinct From/To address seen across the mailbox,
  // newest threads first (so frequent/recent correspondents surface). Skip our own
  // account addresses.
  const contacts = useMemo<Contact[]>(() => {
    const own = new Set(accounts.map((a) => a.email.toLowerCase()));
    const seen = new Set<string>();
    const out: Contact[] = [];
    for (const t of threads) {
      for (const m of t.messages) {
        for (const p of [m.from, ...(m.to ?? [])]) {
          const addr = p?.address?.trim();
          if (!addr || !addr.includes("@")) continue;
          const key = addr.toLowerCase();
          if (seen.has(key) || own.has(key)) continue;
          seen.add(key);
          out.push({ name: p.name?.trim() || undefined, address: addr });
        }
      }
    }
    return out;
  }, [threads, accounts]);

  async function help() {
    setBusy(true);
    const draft = await api.draftReply("__new__", `Subject: ${subject}\nTo: ${to}`);
    editorRef.current?.setHtml(draft);
    setBusy(false);
  }

  async function send(atTs?: number) {
    await queueSend({
      accountId: from || undefined,
      to,
      cc,
      bcc,
      subject,
      body: editorRef.current?.getHtml() ?? "",
      sendAt: atTs,
      attachments: files.map(({ name, mime, dataB64 }) => ({ name, mime, dataB64 })),
    });
    setCompose(false);
  }

  return (
    <section className="stage">
      <motion.div className="stage-inner" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>
        <div className="stage-bar">
          <IconButton icon="close" title="Close" onClick={() => setCompose(false)} />
          <div className="spacer" />
          <IconButton icon="ai" weight="duotone" title="Draft with AI" onClick={help} label={busy ? "Drafting…" : "Draft for me"} />
        </div>
        <h1 className="subject">New message</h1>
        <div className="composer">
          {accounts.length > 0 && (
            <div className="recip-row">
              <span className="recip-lbl">From</span>
              <Select
                value={from}
                onChange={setFrom}
                options={accounts.map((a) => ({ value: a.id, label: a.email }))}
                fullWidth
              />
            </div>
          )}
          <div className="recip-row">
            <span className="recip-lbl">To</span>
            <RecipientChips value={to} onChange={setTo} placeholder="Add people…" suggestions={contacts} />
            {!showCc && (
              <button type="button" className="recip-toggle" onClick={() => setShowCc(true)} title="Add Cc / Bcc">Cc / Bcc</button>
            )}
          </div>
          {showCc && <div className="recip-row"><span className="recip-lbl">Cc</span><RecipientChips value={cc} onChange={setCc} placeholder="Add Cc…" suggestions={contacts} /></div>}
          {showCc && <div className="recip-row"><span className="recip-lbl">Bcc</span><RecipientChips value={bcc} onChange={setBcc} placeholder="Add Bcc…" suggestions={contacts} /></div>}
          <input placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} style={{ ...inp, borderTop: "1px solid var(--border)" }} />
          <div style={{ marginTop: 10 }}>
            <RichText ref={editorRef} initialHtml={initialHtml} placeholder="Write your message… (or let AI draft it)" minHeight={200} />
          </div>
          <div className="cfoot">
            <Button onClick={() => send()} icon="send">Send</Button>
            <SendLater onSchedule={(ts) => send(ts)} />
            <Attachments files={files} onAdd={(f) => setFiles((p) => [...p, ...f])} onRemove={(n) => setFiles((p) => p.filter((x) => x.name !== n))} />
          </div>
        </div>
      </motion.div>
    </section>
  );
}

const inp: React.CSSProperties = {
  width: "100%",
  border: "none",
  background: "transparent",
  color: "var(--text)",
  fontFamily: "var(--font)",
  fontSize: 14,
  padding: "8px 0",
  outline: "none",
};
