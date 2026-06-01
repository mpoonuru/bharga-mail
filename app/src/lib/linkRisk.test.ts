import { describe, it, expect } from "vitest";
import { assessLink, registrableDomain, scanLinks } from "@/lib/linkRisk";

describe("registrableDomain", () => {
  it("returns eTLD+1, handling two-level TLDs", () => {
    expect(registrableDomain("mail.google.com")).toBe("google.com");
    expect(registrableDomain("a.b.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("paypal.com")).toBe("paypal.com");
  });
});

describe("assessLink", () => {
  it("flags text-vs-destination mismatch as dangerous", () => {
    const a = assessLink("http://evil.ru/login", "paypal.com")!;
    expect(a.level).toBe("dangerous");
    expect(a.reasons.join(" ")).toMatch(/actually goes to/i);
  });

  it("flags the userinfo '@' trick", () => {
    expect(assessLink("http://paypal.com@evil.ru/", "Pay now")!.level).toBe("dangerous");
  });

  it("flags punycode look-alikes", () => {
    expect(assessLink("https://xn--80ak6aa92e.com/", "secure")!.level).toBe("dangerous");
  });

  it("flags brand impersonation with a sign-in lure", () => {
    const a = assessLink("http://paypal.com.account-verify.ru/login", "Verify your PayPal account")!;
    expect(a.level).toBe("dangerous");
    expect(a.host).toBe("account-verify.ru");
  });

  it("treats a raw IP as suspicious", () => {
    expect(assessLink("http://203.0.113.9/pay", "click")!.level).toBe("suspicious");
  });

  it("passes a normal first-party https link", () => {
    expect(assessLink("https://www.stripe.com/invoice", "View invoice")!.level).toBe("safe");
  });

  it("ignores non-web links", () => {
    expect(assessLink("mailto:a@b.com", "email")).toBeNull();
    expect(assessLink("#section", "jump")).toBeNull();
  });
});

describe("scanLinks", () => {
  it("returns only risky links, worst first", () => {
    const risky = scanLinks([
      { href: "https://stripe.com/x", text: "ok" },
      { href: "http://1.2.3.4/pay", text: "ip" },
      { href: "http://evil.ru", text: "paypal.com" },
    ]);
    expect(risky).toHaveLength(2);
    expect(risky[0].level).toBe("dangerous");
  });
});
