import { describe, it, expect } from "vitest";
import { messageThreat } from "@/lib/threat";
import type { Message } from "@/types";

function msg(p: { auth?: string; body: string; from?: string }): Message {
  return {
    id: "m",
    from: { name: "", address: p.from ?? "x@evil.com" },
    to: [],
    when: "2026-06-01T00:00:00Z",
    bodyHtml: p.body,
    meta: p.auth ? { auth: p.auth } : undefined,
  };
}

describe("messageThreat", () => {
  it("flags failed auth + a deceptive link as phishing", () => {
    expect(messageThreat(msg({
      auth: "spf=fail; dkim=fail; dmarc=fail",
      body: `Verify now <a href="http://paypal.com.evil.ru/login">paypal.com</a>`,
    })).level).toBe("phishing");
  });

  it("flags a dangerous link inside a sign-in lure as phishing", () => {
    expect(messageThreat(msg({
      auth: "spf=pass; dkim=pass; dmarc=pass",
      body: `Please verify your account <a href="http://paypal.com@evil.ru/">here</a>`,
    })).level).toBe("phishing");
  });

  it("marks a dangerous link alone as suspicious", () => {
    expect(messageThreat(msg({
      auth: "spf=pass; dkim=pass; dmarc=pass",
      body: `see <a href="https://secure-paypal-login.com/x">link</a>`,
    })).level).toBe("suspicious");
  });

  it("is none for a clean, authenticated message", () => {
    expect(messageThreat(msg({
      auth: "spf=pass; dkim=pass; dmarc=pass",
      body: `<p>Hi, see you Thursday at 2.</p>`,
    })).level).toBe("none");
  });
});
