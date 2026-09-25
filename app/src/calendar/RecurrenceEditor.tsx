/** Controlled recurrence rule editor; backend expansion remains authoritative. */

import type { RecurrenceSet } from "@/types";

type Preset = "none" | "daily" | "weekly" | "monthly" | "yearly" | "custom";

const PRESET_RULES: Record<Exclude<Preset, "none" | "custom">, string> = {
  daily: "FREQ=DAILY",
  weekly: "FREQ=WEEKLY",
  monthly: "FREQ=MONTHLY",
  yearly: "FREQ=YEARLY",
};

function presetFor(value: RecurrenceSet | null): Preset {
  if (!value?.rules[0]) return "none";
  const match = Object.entries(PRESET_RULES).find(([, rule]) => rule === value.rules[0]);
  return (match?.[0] as Preset | undefined) ?? "custom";
}

interface RecurrenceEditorProps {
  value: RecurrenceSet | null;
  onChange(value: RecurrenceSet | null): void;
  disabled?: boolean;
}

export function RecurrenceEditor({ value, onChange, disabled = false }: RecurrenceEditorProps) {
  const preset = presetFor(value);
  const choose = (next: Preset) => {
    if (next === "none") onChange(null);
    else if (next === "custom") {
      onChange(value ?? { rules: ["FREQ=WEEKLY"], dates: [], excludedDates: [] });
    } else {
      onChange({ rules: [PRESET_RULES[next]], dates: [], excludedDates: [] });
    }
  };

  return (
    <div className="calendar-recurrence-editor">
      <label className="calendar-field">
        <span>Repeat</span>
        <select aria-label="Repeat" value={preset} onChange={(event) => choose(event.currentTarget.value as Preset)} disabled={disabled}>
          <option value="none">Does not repeat</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
          <option value="custom">Custom rule</option>
        </select>
      </label>
      {preset === "custom" && (
        <label className="calendar-field calendar-field-wide">
          <span>Recurrence rule</span>
          <input
            aria-label="Recurrence rule"
            value={value?.rules[0] ?? ""}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) => onChange({
              rules: [event.currentTarget.value.toUpperCase()],
              dates: value?.dates ?? [],
              excludedDates: value?.excludedDates ?? [],
            })}
          />
          <small>RFC 5545 rule without the RRULE prefix. Complex rules are validated by the calendar core.</small>
        </label>
      )}
    </div>
  );
}
