import { describe, expect, it } from "vitest";

import { ACCOUNT_DISCLOSURE_MOTION } from "@/components/Sidebar";

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
