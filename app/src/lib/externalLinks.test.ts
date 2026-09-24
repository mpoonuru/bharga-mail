// Covers the fail-closed URL boundary used before any email link leaves Bharga.
import { describe, expect, it } from "vitest";
import { parseExternalWebUrl } from "@/lib/externalLinks";

describe("parseExternalWebUrl", () => {
  it("normalizes absolute http and https destinations", () => {
    expect(parseExternalWebUrl("https://Example.com/a?b=1#c")).toEqual({
      href: "https://example.com/a?b=1#c",
      host: "example.com",
    });
    expect(parseExternalWebUrl("http://example.test/path")?.href).toBe("http://example.test/path");
    expect(parseExternalWebUrl("http://[::1]:8080/path")?.host).toBe("[::1]");
    expect(parseExternalWebUrl("https://xn--bcher-kva.example/")?.host).toBe("xn--bcher-kva.example");
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///tmp/private",
    "mailto:person@example.test",
    "/relative/path",
    "not a URL",
    "https:///missing-host",
    "https://user:password@example.test/private",
    "https://example.test\\@evil.test/path",
    "https://exa\tmple.test/path",
    "https://example.test/path\nfragment",
  ])("rejects non-web or malformed destination %s", (value) => {
    expect(parseExternalWebUrl(value)).toBeNull();
  });
});
