import { describe, it, expect } from "vitest";
import { deriveChips, orgFromAddress } from "@/lib/smartChips";
import type { Thread } from "@/types";

// Minimal thread factory — only the fields deriveChips reads.
function thread(p: Partial<Thread> & { id: string; from: string }): Thread {
  return {
    id: p.id,
    accountId: "a1",
    subject: p.subject ?? "s",
    preview: "",
    participants: [p.from],
    lastTime: "2026-06-01T10:00:00Z",
    unread: p.unread ?? false,
    labels: p.labels ?? [],
    view: p.view ?? ["inbox"],
    messages: [{ id: "m", from: { name: "", address: p.from }, to: [], when: "2026-06-01T10:00:00Z", bodyHtml: "" }],
  };
}

describe("orgFromAddress", () => {
  it("maps domains to nice-cased org names", () => {
    expect(orgFromAddress("no-reply@stripe.com")).toBe("Stripe");
    expect(orgFromAddress("x@mail.github.com")).toBe("GitHub");
    expect(orgFromAddress("a@northwind.co")).toBe("Northwind");
  });
  it("returns null without a domain", () => {
    expect(orgFromAddress("not-an-email")).toBeNull();
    expect(orgFromAddress("a@localhost")).toBeNull();
  });
});

describe("deriveChips", () => {
  it("emits signal chips with correct count + unread", () => {
    const chips = deriveChips([
      thread({ id: "1", from: "a@stripe.com", labels: ["receipt"], unread: true }),
      thread({ id: "2", from: "b@x.io", labels: ["urgent"] }),
    ]);
    const receipts = chips.find((c) => c.id === "receipts");
    expect(receipts).toBeTruthy();
    expect(receipts!.count).toBe(1);
    expect(receipts!.unread).toBe(1);
    expect(chips.some((c) => c.id === "urgent")).toBe(true);
  });

  it("only surfaces an org once it forms a cluster (>= 2)", () => {
    const one = deriveChips([thread({ id: "1", from: "a@acme.com" })]);
    expect(one.some((c) => c.id === "org:Acme")).toBe(false);
    const two = deriveChips([
      thread({ id: "1", from: "a@acme.com" }),
      thread({ id: "2", from: "b@acme.com", unread: true }),
    ]);
    const acme = two.find((c) => c.id === "org:Acme");
    expect(acme).toBeTruthy();
    expect(acme!.count).toBe(2);
    expect(acme!.unread).toBe(1);
  });

  it("excludes the user's own domain from clustering", () => {
    const chips = deriveChips([
      thread({ id: "1", from: "me@self.com" }),
      thread({ id: "2", from: "you@self.com" }),
    ], "self.com");
    expect(chips.some((c) => c.id === "org:Self")).toBe(false);
  });

  it("returns nothing for an empty inbox", () => {
    expect(deriveChips([])).toEqual([]);
  });
});
