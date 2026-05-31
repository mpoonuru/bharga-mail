import { useState } from "react";

/** A Gmail/Superhuman-style recipient field: each address is a removable chip,
 *  with an always-present input after them to add the next. Space, comma, or
 *  Enter commits the current draft; Backspace on an empty draft removes the last
 *  chip. The value stays a comma-separated string so it drops into queueSend
 *  unchanged. */
export function RecipientChips({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  const chips = value.split(",").map((s) => s.trim()).filter(Boolean);

  const setChips = (next: string[]) => onChange(Array.from(new Set(next)).join(", "));

  const commit = (raw: string) => {
    const addr = raw.trim().replace(/[,;]+$/, "").trim();
    if (addr) setChips([...chips, addr]);
    setDraft("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === ";" || e.key === " ") {
      if (draft.trim()) {
        e.preventDefault();
        commit(draft);
      }
    } else if (e.key === "Backspace" && !draft && chips.length) {
      setChips(chips.slice(0, -1));
    }
  };

  return (
    <div className="chips-input">
      {chips.map((c) => (
        <span key={c} className="recip-chip">
          {c}
          <button type="button" aria-label={`Remove ${c}`} onClick={() => setChips(chips.filter((x) => x !== c))}>×</button>
        </span>
      ))}
      <input
        className="chips-field"
        value={draft}
        placeholder={chips.length ? "" : placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => draft.trim() && commit(draft)}
      />
    </div>
  );
}
