import { motion } from "motion/react";
import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/icons";

interface Props {
  children: ReactNode;
  onClick?: () => void;
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  variant?: "primary" | "ghost";
}

/** Primary/ghost action button with icon and a processing spinner state. */
export function Button({ children, onClick, icon, loading, disabled, variant = "primary" }: Props) {
  return (
    <motion.button
      className={`af-btn ${variant}`}
      onClick={onClick}
      disabled={disabled || loading}
      whileHover={!disabled && !loading ? { y: -1 } : undefined}
      whileTap={!disabled && !loading ? { scale: 0.97 } : undefined}
    >
      {loading ? <span className="btn-spinner" /> : icon ? <Icon name={icon} size={14} weight="fill" /> : null}
      {children}
    </motion.button>
  );
}
