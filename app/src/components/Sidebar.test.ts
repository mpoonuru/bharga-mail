import { describe, expect, it } from "vitest";

import { ACCOUNT_DISCLOSURE_MOTION, ACCOUNT_REORDER_MOTION, accountReorderLayout } from "@/components/Sidebar";

describe("mail account disclosure motion", () => {
  it("uses a restrained CSS-grid timing contract", () => {
    expect(ACCOUNT_DISCLOSURE_MOTION).toEqual({
      durationMs: 180,
      caretDurationMs: 160,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      offsetPx: 2,
    });
    expect(ACCOUNT_DISCLOSURE_MOTION).not.toHaveProperty("type");
  });
});

describe("mail account reorder motion", () => {
  it("disables layout projection except during an explicit tweened reorder", () => {
    expect(ACCOUNT_REORDER_MOTION.idleLayout).toBe(false);
    expect(ACCOUNT_REORDER_MOTION.activeLayout).toBe("position");
    expect(accountReorderLayout(false)).toBe(false);
    expect(accountReorderLayout(true)).toBe("position");
    expect(ACCOUNT_REORDER_MOTION.transition).toMatchObject({
      type: "tween",
      duration: 0.18,
    });
    expect(ACCOUNT_REORDER_MOTION.transition).not.toHaveProperty("stiffness");
  });
});
