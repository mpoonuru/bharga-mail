import { useMemo, useState } from "react";

export type Contact = { name?: string; address: string };

/** A Gmail/Superhuman-style recipient field: each address is a removable chip,
 *  with an always-present input after them to add the next. Space, comma, or
 *  Enter commits the current draft; Backspace on an empty draft removes the last
 *  chip. The value stays a comma-separated string so it drops into queueSend
 *  unchanged. When `suggestions` are supplied, typing surfaces a contact
 *  autocomplete (↑/↓ to move, Enter/Tab/click to pick). */
export function RecipientChips({
  value,
  onChange,
  placeholder,
  suggestions = [],
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  suggestions?: Contact[];
}) {
  const [draft, setDraft] = useState("");
  const [active, setActive] = useState(0);
  const chips = value.split(",").map((s) => s.trim()).filter(Boolean);

  const setChips = (next: string[]) => onChange(Array.from(new Set(next)).join(", "));

  const commit = (raw: string) => {
    const addr = raw.trim().replace(/[,;]+$/, "").trim();
    if (addr) setChips([...chips, addr]);
    setDraft("");
    setActive(0);
  };

  // Filter contacts by the current draft, skipping ones already added.
  const matches = useMemo(() => {
    const q = draft.trim().toLowerCase();
    if (!q) return [];
    const have = new Set(chips.map((c) => c.toLowerCase()));
    return suggestions
      .filter((c) => !have.has(c.address.toLowerCase()))
      .filter((c) => c.address.toLowerCase().includes(q) || (c.name ?? "").toLowerCase().includes(q))
      .slice(0, 6);
  }, [draft, suggestions, chips]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (matches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setActive((i) => (e.key === "ArrowDown" ? (i + 1) % matches.length : (i - 1 + matches.length) % matches.length));
      return;
    }
    if (matches.length && (e.key === "Enter" || e.key === "Tab")) {
      e.preventDefault();
      commit(matches[active].address);
      return;
    }
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
      <div className="chips-entry">
        <input
          className="chips-field"
          value={draft}
          placeholder={chips.length ? "" : placeholder}
          onChange={(e) => { setDraft(e.target.value); setActive(0); }}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => { if (draft.trim()) commit(draft); }, 120)}
        />
        {matches.length > 0 && (
          <ul className="recip-suggest" role="listbox">
            {matches.map((c, i) => (
              <li
                key={c.address}
                role="option"
                aria-selected={i === active}
                className={i === active ? "active" : ""}
                onMouseDown={(e) => { e.preventDefault(); commit(c.address); }}
                onMouseEnter={() => setActive(i)}
              >
                {c.name && <span className="rs-name">{c.name}</span>}
                <span className="rs-addr">{c.address}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
