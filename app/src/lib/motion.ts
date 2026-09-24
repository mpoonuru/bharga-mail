import { useReducedMotion } from "motion/react";

// Shared motion contract for every routine Bharga interaction.
export const MOTION = {
  instant: 0.09,
  standard: 0.14,
  disclosure: 0.16,
  structural: 0.2,
} as const;

export const MOTION_EASE = [0.2, 0.8, 0.2, 1] as const;

export type MotionKind = keyof typeof MOTION;

export function motionTransition(kind: MotionKind) {
  return {
    type: "tween" as const,
    duration: MOTION[kind],
    ease: MOTION_EASE,
  };
}

export const THREAD_CROSSFADE = {
  ...motionTransition("standard"),
  duration: 0.12,
} as const;

export const OVERLAY_FADE = motionTransition("standard");
export const STRUCTURAL_TRANSITION = motionTransition("structural");

export function motionTransitionForPreference<T extends { duration: number }>(
  transition: T,
  prefersReducedMotion: boolean | null,
): T {
  if (!prefersReducedMotion) return transition;
  return { ...transition, duration: 0 };
}

/** Applies the OS reduced-motion preference to explicit Motion transitions. */
export function useMotionTransition<T extends { duration: number }>(transition: T): T {
  return motionTransitionForPreference(transition, useReducedMotion());
}
