import { describe, it, expect } from "vitest";
import { senderTrust } from "@/lib/senderTrust";

describe("senderTrust", () => {
  it("verifies when DMARC passes with aligned SPF/DKIM", () => {
    const t = senderTrust("spf=pass; dkim=pass; dmarc=pass");
    expect(t.level).toBe("verified");
    expect(t.icon).toBe("shieldCheck");
    expect(t.tone).toBe("ok");
  });

  it("flags failure when DMARC fails (spoofing risk)", () => {
    const t = senderTrust("spf=fail; dkim=fail; dmarc=fail");
    expect(t.level).toBe("failed");
    expect(t.icon).toBe("shieldWarning");
    expect(t.tone).toBe("bad");
    expect(t.detail).toMatch(/spoof/i);
  });

  it("is cautious when something passes but DMARC isn't aligned", () => {
    const t = senderTrust("spf=pass; dkim=fail; dmarc=none");
    expect(t.level).toBe("caution");
    expect(t.tone).toBe("warn");
  });

  it("treats softfail / reject as failures", () => {
    expect(senderTrust("spf=softfail; dkim=fail; dmarc=reject").level).toBe("failed");
  });

  it("is unknown with no auth data", () => {
    expect(senderTrust(undefined).level).toBe("unknown");
    expect(senderTrust("").level).toBe("unknown");
  });
});
