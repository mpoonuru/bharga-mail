import { describe, it, expect } from "vitest";
import dayjs from "dayjs";
import { shortTime, fullTime } from "@/lib/date";

describe("date formatting", () => {
  it("shows HH:mm for today (ISO)", () => {
    const iso = dayjs().hour(9).minute(24).second(0).toISOString();
    expect(shortTime(iso)).toMatch(/^\d{2}:\d{2}$/);
  });

  it("parses RFC 2822 (Gmail/IMAP Date header)", () => {
    // a fixed past date → absolute short form, not the raw string
    const out = shortTime("Mon, 25 May 2026 06:00:00 +0000");
    expect(out).not.toContain("2026 06:00:00");
    expect(out.length).toBeLessThan(14);
  });

  it("falls back to the raw string when unparseable", () => {
    expect(shortTime("9:24")).toBe("9:24");
    expect(fullTime("Yest")).toBe("Yest");
  });

  it("fullTime gives relative for very recent", () => {
    const recent = dayjs().subtract(2, "hour").toISOString();
    expect(fullTime(recent)).toMatch(/ago/);
  });
});
