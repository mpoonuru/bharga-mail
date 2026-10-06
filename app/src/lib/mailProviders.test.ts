// Verifies that native mail-provider failures become safe, actionable UI errors.
import { describe, expect, it } from "vitest";

import { toMailConnectionError } from "@/lib/mailProviders";

describe("mail provider errors", () => {
  it("preserves recognized structured native failures", () => {
    expect(toMailConnectionError({
      code: "tenant_restricted",
      message: "Your organization blocked this sign-in.",
      retryable: false,
    })).toEqual({
      code: "tenant_restricted",
      message: "Your organization blocked this sign-in.",
      retryable: false,
    });
  });

  it("does not expose ordinary error details", () => {
    expect(toMailConnectionError(new Error("token response contained private details"))).toEqual({
      code: "unexpected",
      message: "The account could not be connected. Try again.",
      retryable: true,
    });
  });

  it("does not expose unknown rejection values", () => {
    expect(toMailConnectionError("https://provider.test/callback?code=private")).toEqual({
      code: "unexpected",
      message: "The account could not be connected. Try again.",
      retryable: true,
    });
  });
});
