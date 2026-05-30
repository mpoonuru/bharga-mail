import { useState } from "react";
import { CaretUpDownIcon, CheckIcon } from "@phosphor-icons/react";

export interface SelectOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  fullWidth?: boolean;
  className?: string;
}

// Custom dropdown matching the Topup Arena Select (button + caret + checkmark
// options), built without Headless UI to keep deps light. Themed to our tokens.
export function Select({ value, onChange, options, placeholder = "Select…", fullWidth, className }: Props) {
  const [open, setOpen] = useState(false);
  const sel = options.find((o) => o.value === value);

  return (
    <div className={`ta-select${fullWidth ? " w-full" : ""} ${className || ""}`} style={{ position: "relative" }}>
      <button type="button" className="ta-select-btn" onClick={() => setOpen((v) => !v)}>
        <span className={sel ? "" : "ta-ph"}>{sel ? sel.label : placeholder}</span>
        <CaretUpDownIcon size={15} className="ta-caret" />
      </button>
      {open && (
        <>
          <div className="ta-select-backdrop" onClick={() => setOpen(false)} />
          <div className="ta-select-menu">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`ta-select-opt${o.value === value ? " sel" : ""}`}
                onClick={() => { onChange(o.value); setOpen(false); }}
              >
                {o.value === value && <CheckIcon size={13} weight="bold" className="ta-check" />}
                <span>{o.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
