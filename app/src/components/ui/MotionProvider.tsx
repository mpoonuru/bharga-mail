// Applies the user's operating-system motion preference to Motion for React.

import { MotionConfig } from "motion/react";
import type { PropsWithChildren } from "react";

export const REDUCED_MOTION_POLICY = "user" as const;

export function MotionProvider({ children }: PropsWithChildren) {
  return <MotionConfig reducedMotion={REDUCED_MOTION_POLICY}>{children}</MotionConfig>;
}
