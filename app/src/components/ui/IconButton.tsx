import type { IconWeight } from "@phosphor-icons/react";
import { Icon, type IconName } from "@/components/icons";
import { Tooltip } from "@/components/ui/Tooltip";

interface Props {
  icon: IconName;
  title: string;
  onClick?: () => void;
  label?: string; // optional text beside the icon
  size?: number;
  weight?: IconWeight;
  tipSide?: "top" | "bottom" | "right";
}

/** Square ghost button used across toolbars and composers, with the custom
 *  (glass) tooltip instead of the native one. */
export function IconButton({ icon, title, onClick, label, size = 16, weight = "duotone", tipSide = "bottom" }: Props) {
  return (
    <Tooltip label={title} side={tipSide}>
      <button
        className="iconbtn"
        aria-label={title}
        onClick={onClick}
        style={label ? { width: "auto" } : undefined}
      >
        <Icon name={icon} size={size} weight={weight} />
        {label}
      </button>
    </Tooltip>
  );
}
