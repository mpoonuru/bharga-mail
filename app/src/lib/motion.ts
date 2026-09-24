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
