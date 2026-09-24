// Regression coverage for sender selection and reply-recipient normalization.
import { describe, expect, it } from "vitest";
import { accountAddress, replyRecipients, resolveSendAccountId } from "@/lib/accountIdentity";

const accounts = [
  { id: "personal", email: "alex@example.com", provider: "imap" as const, displayName: "Alex" },
  { id: "work", email: "alex@company.test", provider: "microsoft" as const, displayName: "Alex Work" },
];

describe("account identity", () => {
  it("prefers the thread account over the selected account for replies", () => {
    expect(resolveSendAccountId({ accounts, explicitId: undefined, threadAccountId: "work", selectedId: "personal" })).toBe("work");
  });

  it("fails closed when no connected account can be resolved", () => {
    expect(() => resolveSendAccountId({ accounts: [], explicitId: undefined, threadAccountId: undefined, selectedId: undefined }))
      .toThrow("Choose a connected account before sending.");
  });

  it("does not accept an unknown explicit account", () => {
    expect(() => resolveSendAccountId({ accounts, explicitId: "missing", threadAccountId: undefined, selectedId: undefined }))
      .toThrow("The selected sending account is no longer connected.");
  });

  it("finds the real address for the thread account", () => {
    expect(accountAddress(accounts, "work")).toBe("alex@company.test");
  });

  it("excludes self and deduplicates reply-all recipients case-insensitively", () => {
    expect(replyRecipients({
      self: "alex@company.test",
      sender: "person@example.net",
      to: ["Alex@Company.test", "team@example.net", "TEAM@example.net"],
      cc: ["audit@example.net", "person@example.net"],
    })).toEqual({ to: "person@example.net, team@example.net", cc: "audit@example.net" });
  });
});
