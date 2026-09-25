// Accessible listbox-style select shared by account, compose, and preference flows.
import { useId, useRef, useState } from "react";
import { CaretUpDownIcon, CheckIcon } from "@phosphor-icons/react";

export interface SelectOption {
  value: string;
  label: string;
}

interface Props {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  fullWidth?: boolean;
  className?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
}

export function Select({
  id,
  value,
  onChange,
  options,
  placeholder = "Select…",
  fullWidth,
  className,
  ariaLabel,
  ariaLabelledBy,
}: Props) {
  const generatedId = useId();
  const buttonId = id ?? generatedId;
  const menuId = `${buttonId}-listbox`;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options.find((option) => option.value === value);

  function focusOption(index: number) {
    if (!options.length) return;
    const next = (index + options.length) % options.length;
    setActiveIndex(next);
    requestAnimationFrame(() => optionRefs.current[next]?.focus());
  }

  function openAt(index: number) {
    setOpen(true);
    focusOption(index);
  }

  function close(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => buttonRef.current?.focus());
  }

  function choose(option: SelectOption) {
    onChange(option.value);
    close();
  }

  return (
    <div className={`ta-select${fullWidth ? " w-full" : ""} ${className || ""}`} style={{ position: "relative" }}>
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        className="ta-select-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        data-select-open={open ? "true" : undefined}
        onClick={() => open ? close(false) : openAt(selectedIndex)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openAt(event.key === "ArrowDown" ? selectedIndex : Math.max(0, options.length - 1));
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            openAt(event.key === "Home" ? 0 : Math.max(0, options.length - 1));
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      >
        <span className={selected ? "" : "ta-ph"}>{selected ? selected.label : placeholder}</span>
        <CaretUpDownIcon size={15} className="ta-caret" />
      </button>
      {open && (
        <>
          <button type="button" className="ta-select-backdrop" tabIndex={-1} aria-hidden="true" onClick={() => close()} />
          <div
            id={menuId}
            className="ta-select-menu"
            role="listbox"
            aria-label={ariaLabel}
            aria-labelledby={ariaLabel ? undefined : ariaLabelledBy ?? buttonId}
            data-select-owner={buttonId}
          >
            {options.map((option, index) => (
              <button
                ref={(node) => { optionRefs.current[index] = node; }}
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                tabIndex={index === activeIndex ? 0 : -1}
                className={`ta-select-opt${option.value === value ? " sel" : ""}`}
                onClick={() => choose(option)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    focusOption(index + (event.key === "ArrowDown" ? 1 : -1));
                  } else if (event.key === "Home" || event.key === "End") {
                    event.preventDefault();
                    focusOption(event.key === "Home" ? 0 : options.length - 1);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    close();
                  } else if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    choose(option);
                  } else if (event.key === "Tab") {
                    setOpen(false);
                  }
                }}
              >
                {option.value === value && <CheckIcon size={13} weight="bold" className="ta-check" />}
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
