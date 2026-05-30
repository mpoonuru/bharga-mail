import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/icons";

type Variant = "ai" | "urgent" | "cal";

interface Props {
  children: ReactNode;
  variant: Variant;
  icon?: IconName;
}

/** Small status tag (Urgent, Meeting, AI draft ready, …). */
export function Tag({ children, variant, icon }: Props) {
  return (
    <span className={`tag ${variant}`}>
      {icon && <Icon name={icon} size={10} weight="fill" />}
      {children}
    </span>
  );
}
