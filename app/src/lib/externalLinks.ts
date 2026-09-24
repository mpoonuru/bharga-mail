// Fail-closed parsing boundary for URLs originating in untrusted email HTML.
export interface ExternalWebUrl {
  href: string;
  host: string;
}

export function parseExternalWebUrl(raw: string): ExternalWebUrl | null {
  const value = raw.trim();
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
  if (!/^https?:\/\/[^/\s]/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.username !== "" ||
      url.password !== ""
    ) return null;
    return { href: url.href, host: url.hostname.toLowerCase() };
  } catch {
    return null;
  }
}
