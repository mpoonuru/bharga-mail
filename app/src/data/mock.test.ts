import { describe, expect, it } from "vitest";

import * as mock from "@/data/mock";

describe("open-source demo data", () => {
  it("contains no organization-specific identity", () => {
    const serialized = JSON.stringify(mock).toLowerCase();

    expect(serialized).not.toContain(["pj", "telesoft"].join(""));
  });

  it("uses a reserved domain for the demo account", () => {
    expect(mock.account.email).toMatch(/@example\.(com|org|net)$/);
  });
});
