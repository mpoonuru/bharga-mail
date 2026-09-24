// Protects the boundary between desktop pointer input and touch swipe gestures.
import { describe, expect, it } from "vitest";
import { mailDragPolicy } from "@/lib/pointer";

describe("mailDragPolicy", () => {
  it("disables horizontal drag for precise desktop pointers", () => {
    expect(mailDragPolicy(false)).toEqual({ drag: false, dragElastic: 0 });
  });

  it("enables restrained horizontal drag for coarse touch pointers", () => {
    expect(mailDragPolicy(true)).toEqual({ drag: "x", dragElastic: 0.35 });
  });
});
