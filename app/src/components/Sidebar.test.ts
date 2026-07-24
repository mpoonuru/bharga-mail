import { describe, expect, it } from "vitest";

import { ACCOUNT_ACCORDION_TRANSITION } from "@/components/Sidebar";

describe("mail account accordion motion", () => {
  it("uses a responsive spring without a fixed duration", () => {
    expect(ACCOUNT_ACCORDION_TRANSITION.type).toBe("spring");
    expect(ACCOUNT_ACCORDION_TRANSITION.stiffness).toBeGreaterThanOrEqual(300);
    expect(ACCOUNT_ACCORDION_TRANSITION.damping).toBeGreaterThanOrEqual(25);
    expect(ACCOUNT_ACCORDION_TRANSITION).not.toHaveProperty("duration");
  });
});
