import { useRef } from "react";
import { Icon } from "@/components/icons";

export interface Attach {
  name: string;
  size: number;
  mime: string;
  dataB64: string;
}

function readAsBase64(file: File): Promise<Attach> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const result = String(r.result);
      const b64 = result.includes(",") ? result.slice(result.indexOf(",") + 1) : result;
      resolve({ name: file.name, size: file.size, mime: file.type || "application/octet-stream", dataB64: b64 });
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

interface Props {
  files: Attach[];
  onAdd: (files: Attach[]) => void;
  onRemove: (name: string) => void;
}

function human(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Attachment picker + chips. Holds metadata in the composer; binary transport
// is wired in the Rust send path (Phase 1 for cloud providers).
export function Attachments({ files, onAdd, onRemove }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={async (e) => {
          const picked = await Promise.all(Array.from(e.target.files ?? []).map(readAsBase64));
          if (picked.length) onAdd(picked);
          e.target.value = "";
        }}
      />
      <button className="iconbtn" title="Attach files" onClick={() => inputRef.current?.click()}>
        <Icon name="attach" />
      </button>
      {files.length > 0 && (
        <div className="attach-row">
          {files.map((f) => (
            <span className="attach-chip" key={f.name}>
              <Icon name="attach" size={12} /> {f.name} <span className="attach-size">{human(f.size)}</span>
              <button className="attach-x" title="Remove" onClick={() => onRemove(f.name)}>
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}
