import { Icon } from "@/components/icons";
import { Tooltip } from "@/components/ui/Tooltip";
import type { SmartChip } from "@/lib/smartChips";

/** Horizontal, multi-select smart-filter bar shown above the mail stream.
 *  Chips are derived per-view (see lib/smartChips). Selecting chips filters the
 *  stream to their union; nothing selected = show everything. Each chip explains
 *  itself on hover (why it exists) — AI-first grouping should never be a black box. */
export function SmartChips({
  chips, active, onToggle, onClear,
}: {
  chips: SmartChip[];
  active: Set<string>;
  onToggle: (id: string) => void;
  onClear: () => void;
}) {
  if (!chips.length) return null;
  return (
    <div className="smart-chips" role="tablist" aria-label="Smart filters">
      <Tooltip label="Auto-grouped from your inbox by AI — multi-label, so a mail can match several." side="bottom">
        <span className="smart-chips-lead" aria-hidden><Icon name="ai" size={13} weight="duotone" /></span>
      </Tooltip>
      {active.size > 0 && (
        <button className="chip chip-clear" onClick={onClear} title="Clear filters" aria-label="Clear filters">
          <Icon name="close" size={11} weight="bold" />
        </button>
      )}
      {chips.map((c) => {
        const on = active.has(c.id);
        return (
          <Tooltip key={c.id} label={c.why} side="bottom">
            <button
              className={`chip chip-${c.kind}${on ? " on" : ""}`}
              onClick={() => onToggle(c.id)}
              role="tab"
              aria-selected={on}
            >
              <Icon name={c.icon} size={12} weight="duotone" />
              <span className="chip-label">{c.label}</span>
              <span className="chip-count">{c.count}</span>
              {c.unread > 0 && <span className="chip-new">{c.unread} new</span>}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
