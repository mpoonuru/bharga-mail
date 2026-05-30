import { useRef, useState } from "react";
import { motion } from "motion/react";
import { useApp } from "@/store";
import { api } from "@/lib/bridge";
import { IconButton } from "@/components/ui/IconButton";
import { Button } from "@/components/ui/Button";
import { RichText, type RichTextHandle } from "@/components/ui/RichText";
import { Attachments, type Attach } from "@/components/ui/Attachments";

// Full-screen new-message composer (opened from the sidebar or the "C" hotkey).
export function Compose() {
  const setCompose = useApp((s) => s.setCompose);
  const queueSend = useApp((s) => s.queueSend);
  const defaultSig = useApp((s) => s.signatures.find((x) => x.id === s.defaultSignatureId));
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [files, setFiles] = useState<Attach[]>([]);
  const [busy, setBusy] = useState(false);
  const editorRef = useRef<RichTextHandle>(null);
  const initialHtml = defaultSig?.html ? `<p></p><p>--<br>${defaultSig.html}</p>` : "";

  async function help() {
    setBusy(true);
    const draft = await api.draftReply("__new__", `Subject: ${subject}\nTo: ${to}`);
    editorRef.current?.setHtml(draft);
    setBusy(false);
  }

  async function send() {
    await queueSend({
      to,
      subject,
      body: editorRef.current?.getHtml() ?? "",
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
          <input placeholder="To" value={to} onChange={(e) => setTo(e.target.value)} style={inp} />
          <input placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} style={{ ...inp, borderTop: "1px solid var(--border)" }} />
          <div style={{ marginTop: 10 }}>
            <RichText ref={editorRef} initialHtml={initialHtml} placeholder="Write your message… (or let AI draft it)" minHeight={200} />
          </div>
          <div className="cfoot">
            <Button onClick={send} icon="send">Send</Button>
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
