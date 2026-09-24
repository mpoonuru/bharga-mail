// Ensures Bharga delegates animation reduction to the operating-system preference.
import { describe, expect, it } from "vitest";
import { REDUCED_MOTION_POLICY } from "@/components/ui/MotionProvider";

describe("MotionProvider", () => {
  it("uses the user's reduced-motion preference", () => {
    expect(REDUCED_MOTION_POLICY).toBe("user");
  });
});
