import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/icons";

interface Props {
  children: ReactNode;
  icon?: IconName;
  solid?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}

/** Pill-shaped action chip (AI summary actions, role toggles, etc.). */
export function Chip({ children, icon, solid, onClick, disabled, title }: Props) {
  return (
    <button
      className={`chip${solid ? " solid" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={disabled ? { opacity: 0.4 } : undefined}
    >
      {icon && <Icon name={icon} size={13} />}
      {children}
    </button>
  );
}
