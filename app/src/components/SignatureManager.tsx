import { useRef, useState } from "react";
import { useApp } from "@/store";
import { Modal } from "@/components/ui/Modal";
import { RichText, type RichTextHandle } from "@/components/ui/RichText";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/icons";
import { sanitizeEmail } from "@/lib/emailHtml";

// Manage multiple rich-text signatures: list, add, edit, delete, set default.
export function SignatureManager() {
  const { signatures, defaultSignatureId, addSignature, updateSignature, deleteSignature, setDefaultSignature } = useApp();
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [name, setName] = useState("");
  const editorRef = useRef<RichTextHandle>(null);

  const current = editing?.id ? signatures.find((s) => s.id === editing.id) : null;

  function openNew() {
    setName("");
    setEditing({ id: null });
  }
  function openEdit(id: string) {
    const s = signatures.find((x) => x.id === id);
    setName(s?.name ?? "");
    setEditing({ id });
  }
  function save() {
    const html = editorRef.current?.getHtml() ?? "";
    if (editing?.id) updateSignature(editing.id, { name: name || "Untitled", html });
    else addSignature(name || "Untitled", html);
    setEditing(null);
  }

  return (
    <>
      {signatures.length === 0 && <p className="sub" style={{ margin: "0 0 10px" }}>No signatures yet.</p>}
      {signatures.map((s) => (
        <div className="sig-row" key={s.id}>
          <button className="sig-default" title={defaultSignatureId === s.id ? "Default" : "Set as default"} onClick={() => setDefaultSignature(s.id)}>
            <Icon name={defaultSignatureId === s.id ? "ai" : "tasks"} size={14} weight={defaultSignatureId === s.id ? "fill" : "duotone"} />
          </button>
          <div className="sig-info">
            <b>{s.name}{defaultSignatureId === s.id && <span className="sig-badge">Default</span>}</b>
            <div className="sig-preview" dangerouslySetInnerHTML={{ __html: sanitizeEmail(s.html) }} />
          </div>
          <button className="iconbtn" title="Edit" onClick={() => openEdit(s.id)}><Icon name="compose" size={14} /></button>
          <button className="iconbtn" title="Delete" onClick={() => deleteSignature(s.id)}><Icon name="close" size={14} /></button>
        </div>
      ))}
      <button className="af-btn ghost" style={{ marginTop: 10 }} onClick={openNew}><Icon name="plus" size={14} /> Add signature</button>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? "Edit signature" : "New signature"} maxWidth={620}>
        <div className="af-field" style={{ marginBottom: 12 }}>
          <label>Name</label>
          <input className="af-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Work, Personal" />
        </div>
        <div className="af-field">
          <label>Signature (rich text)</label>
          <RichText ref={editorRef} initialHtml={current?.html ?? ""} placeholder="Your name, title, links…" minHeight={140} />
        </div>
        <div className="af-actions" style={{ justifyContent: "flex-end" }}>
          <button className="af-btn ghost" onClick={() => setEditing(null)}><Icon name="close" size={14} /> Cancel</button>
          <Button onClick={save} icon="send">Save signature</Button>
        </div>
      </Modal>
    </>
  );
}
