import { describe, expect, it } from "vitest";

import { ACCOUNT_ACCORDION_TRANSITION } from "@/components/Sidebar";

describe("mail account accordion motion", () => {
  it("uses a deterministic cubic-bezier curve", () => {
    expect(ACCOUNT_ACCORDION_TRANSITION.type).toBe("tween");
    expect(ACCOUNT_ACCORDION_TRANSITION.duration).toBeGreaterThanOrEqual(0.2);
    expect(ACCOUNT_ACCORDION_TRANSITION.duration).toBeLessThanOrEqual(0.3);
    expect(ACCOUNT_ACCORDION_TRANSITION.ease).toEqual([0.22, 1, 0.36, 1]);
  });
});
