/** A human display name for a sender. Uses the real display name when present
 *  and distinct from the address; otherwise prettifies the email local part
 *  ("john.doe@x.com" → "John Doe", "kranthi@x.it" → "Kranthi"). */
export function senderLabel(name: string | undefined, address: string): string {
  const n = (name || "").trim();
  if (n && n.toLowerCase() !== (address || "").toLowerCase()) return n;
  const local = (address || "").split("@")[0] || address || "";
  const pretty = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return pretty || address || "Unknown";
}

/** Whether a separate muted address line should be shown beneath the name. */
export function showAddressLine(name: string | undefined, address: string): boolean {
  return senderLabel(name, address).toLowerCase() !== (address || "").toLowerCase();
}

/** A short, readable mailbox/folder label: "INBOX" → "Inbox", "INBOX.Sent" → "Sent". */
export function folderLabel(folder: string | undefined): string {
  const f = (folder || "INBOX").trim();
  const leaf = f.split(/[/.]/).filter(Boolean).pop() || f;
  return /^inbox$/i.test(leaf) ? "Inbox" : leaf;
}

/** Two-letter avatar initials from a display name OR a bare email address.
 *  "Hemalatha Panguru" → "HP", "Super Admin" → "SA",
 *  "rechnungen@e-aufladen.de" → "RE" (local part when there's no name). */
export function initials(nameOrEmail: string): string {
  const s = (nameOrEmail || "").trim();
  if (!s) return "?";
  // Email with no display name → derive from the local part before "@".
  const base = (s.includes("@") ? s.split("@")[0] : s).trim();
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}
