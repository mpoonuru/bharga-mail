// Accessible preset color swatch picker. Follows the enterprise pattern used by
// Feishu/Ant/Semi design systems: a small fixed, perceptual palette instead of a
// free color wheel, a clear selected state, and an "auto" option that keeps the
// deterministic per-account hash. Native radio inputs give roving arrow-key
// navigation and correct semantics for free.
import { useId } from "react";

import { Icon } from "@/components/icons";
import { ACCOUNT_COLOR_CHOICES, type AccountColorChoice, accountColorFromHue } from "@/lib/colors";

export function ColorSwatchPicker({
  value,
  onChange,
  options = ACCOUNT_COLOR_CHOICES,
  label = "Account color",
}: {
  value: string | undefined;
  onChange: (key: string) => void;
  options?: readonly AccountColorChoice[];
  label?: string;
}) {
  const current = value ?? "auto";
  const groupName = useId();
  return (
    <div className="color-swatches" role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const hue = option.hue;
        const selected = current === option.key;
        return (
          <label
            key={option.key}
            className={`color-swatch${selected ? " on" : ""}${hue === null ? " auto" : ""}`}
            style={hue === null ? undefined : { background: accountColorFromHue(hue) }}
            title={option.name}
          >
            <input
              type="radio"
              name={groupName}
              value={option.key}
              checked={selected}
              onChange={() => onChange(option.key)}
              aria-label={option.name}
            />
            {selected && <Icon name="check" size={11} weight="bold" />}
          </label>
        );
      })}
    </div>
  );
}
