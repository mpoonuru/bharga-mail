import { motion } from "motion/react";
import type { IconWeight } from "@phosphor-icons/react";
import { Icon, type IconName } from "@/components/icons";

interface Props {
  icon: IconName;
  title: string;
  onClick?: () => void;
  label?: string; // optional text beside the icon
  size?: number;
  weight?: IconWeight;
}

/** Square ghost button used across toolbars and composers. */
export function IconButton({ icon, title, onClick, label, size = 16, weight = "duotone" }: Props) {
  return (
    <motion.button
      className="iconbtn"
      title={title}
      aria-label={title}
      onClick={onClick}
      whileTap={{ scale: 0.94 }}
      style={label ? { width: "auto" } : undefined}
    >
      <Icon name={icon} size={size} weight={weight} />
      {label}
    </motion.button>
  );
}
