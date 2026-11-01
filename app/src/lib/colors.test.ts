import { describe, expect, it } from "vitest";

import { ACCOUNT_COLOR_CHOICES, accountColor, resolveAccountColor } from "./colors";

describe("resolveAccountColor", () => {
  it("falls back to the stable hash for auto, missing, or unknown keys", () => {
    const id = "imap:me@example.com";
    const auto = accountColor(id);
    expect(resolveAccountColor(id, undefined)).toBe(auto);
    expect(resolveAccountColor(id, "auto")).toBe(auto);
    expect(resolveAccountColor(id, "does-not-exist")).toBe(auto);
  });

  it("uses the chosen preset hue when one is set", () => {
    expect(ACCOUNT_COLOR_CHOICES.find((choice) => choice.key === "teal")?.hue).toBe(200);
    expect(resolveAccountColor("imap:me@example.com", "teal")).toBe("oklch(0.7 0.15 200)");
  });

  it("keeps the account's auto color stable across calls", () => {
    expect(accountColor("imap:a@x")).toBe(accountColor("imap:a@x"));
  });
});
