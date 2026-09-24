// Protects Bharga's calm-motion timing and tween-only routine transition policy.
import { describe, expect, it } from "vitest";
import { motionTransition, motionTransitionForPreference, OVERLAY_FADE } from "@/lib/motion";

describe("motionTransition", () => {
  it("builds the approved transition for each interaction class", () => {
    expect(motionTransition("instant")).toEqual({
      type: "tween",
      duration: 0.09,
      ease: [0.2, 0.8, 0.2, 1],
    });
    expect(motionTransition("standard")).toEqual({
      type: "tween",
      duration: 0.14,
      ease: [0.2, 0.8, 0.2, 1],
    });
    expect(motionTransition("disclosure")).toEqual({
      type: "tween",
      duration: 0.16,
      ease: [0.2, 0.8, 0.2, 1],
    });
    expect(motionTransition("structural")).toEqual({
      type: "tween",
      duration: 0.2,
      ease: [0.2, 0.8, 0.2, 1],
    });
  });

  it("uses a 120 ms opacity transition for conversation changes", async () => {
    const { THREAD_CROSSFADE } = await import("@/lib/motion");
    expect(THREAD_CROSSFADE).toEqual({
      type: "tween",
      duration: 0.12,
      ease: [0.2, 0.8, 0.2, 1],
    });
  });

  it("makes explicit Motion transitions instant when reduced motion is requested", () => {
    expect(motionTransitionForPreference(OVERLAY_FADE, true)).toEqual({
      ...OVERLAY_FADE,
      duration: 0,
    });
    expect(motionTransitionForPreference(OVERLAY_FADE, false)).toBe(OVERLAY_FADE);
  });
});
