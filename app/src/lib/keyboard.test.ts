// Verifies the keyboard contracts shared by composite mail rows.
import { describe, expect, it } from "vitest";
import { isKeyboardContextMenu, isPrimaryActivationKey } from "@/lib/keyboard";

describe("mail-row keyboard policy", () => {
  it("accepts only native button activation keys", () => {
    expect(isPrimaryActivationKey("Enter")).toBe(true);
    expect(isPrimaryActivationKey(" ")).toBe(true);
    expect(isPrimaryActivationKey("ArrowDown")).toBe(false);
  });

  it("recognizes keyboard context-menu gestures", () => {
    expect(isKeyboardContextMenu({ key: "F10", shiftKey: true })).toBe(true);
    expect(isKeyboardContextMenu({ key: "ContextMenu", shiftKey: false })).toBe(true);
    expect(isKeyboardContextMenu({ key: "F10", shiftKey: false })).toBe(false);
  });
});
