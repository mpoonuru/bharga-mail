import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import customParseFormat from "dayjs/plugin/customParseFormat";

dayjs.extend(relativeTime);
dayjs.extend(customParseFormat);

// Providers hand us mixed date formats: ISO 8601 (Graph), RFC 2822 (Gmail/IMAP
// `Date:` headers), or pre-formatted seed strings. Parse leniently; if we can't,
// fall back to the raw string so nothing breaks.
function parse(raw: string) {
  if (!raw) return null;
  let d = dayjs(raw); // handles ISO + many common forms
  if (!d.isValid()) d = dayjs(raw, "ddd, DD MMM YYYY HH:mm:ss ZZ"); // RFC 2822
  return d.isValid() ? d : null;
}

/** Epoch milliseconds for sorting. RFC 2822 / ISO are NOT lexically sortable, so
 *  always sort on this, never on the raw string. Unparseable → 0 (sinks to oldest). */
export function whenMs(raw: string): number {
  return parse(raw)?.valueOf() ?? 0;
}

/** Compact list timestamp: time today, weekday this week, else short date. */
export function shortTime(raw: string): string {
  const d = parse(raw);
  if (!d) return raw;
  const now = dayjs();
  if (d.isSame(now, "day")) return d.format("HH:mm");
  if (now.diff(d, "day") < 7) return d.format("ddd");
  if (d.isSame(now, "year")) return d.format("MMM D");
  return d.format("MMM D, YYYY");
}

/** Full timestamp for the reading pane (relative if recent, absolute otherwise). */
export function fullTime(raw: string): string {
  const d = parse(raw);
  if (!d) return raw;
  if (dayjs().diff(d, "hour") < 24) return d.fromNow(); // "3 hours ago"
  return d.format("MMM D, YYYY · HH:mm");
}
