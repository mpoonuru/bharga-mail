import dayjs from "dayjs";
import "dayjs/locale/de";
import "dayjs/locale/fr";
import "dayjs/locale/es";
import "dayjs/locale/it";

// User-choosable fonts (bundled variable fonts + system stack). Mirrors how
// iTopup ships Inter while still allowing system fallback.
export const FONTS: { value: string; label: string; stack: string }[] = [
  { value: "system", label: "System default", stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
  { value: "inter", label: "Inter", stack: '"Inter Variable", "Inter", system-ui, sans-serif' },
  { value: "figtree", label: "Figtree", stack: '"Figtree Variable", system-ui, sans-serif' },
  { value: "mono", label: "JetBrains Mono", stack: '"JetBrains Mono Variable", ui-monospace, monospace' },
];

export const LOCALES: { value: string; label: string }[] = [
  { value: "en", label: "English (12/31/2026)" },
  { value: "de", label: "Deutsch (31.12.2026)" },
  { value: "fr", label: "Français" },
  { value: "es", label: "Español" },
  { value: "it", label: "Italiano" },
];

const FONT_KEY = "aether.font";
const LOCALE_KEY = "aether.locale";

export function loadFont(): string {
  try { return localStorage.getItem(FONT_KEY) ?? "inter"; } catch { return "inter"; }
}
export function applyFont(value: string) {
  const f = FONTS.find((x) => x.value === value) ?? FONTS[1];
  document.documentElement.style.setProperty("--font", f.stack);
  try { localStorage.setItem(FONT_KEY, value); } catch { /* ignore */ }
}

export function loadLocale(): string {
  try { return localStorage.getItem(LOCALE_KEY) ?? "en"; } catch { return "en"; }
}
export function applyLocale(value: string) {
  dayjs.locale(value); // locale-driven date/number formatting (iTopup pattern)
  try { localStorage.setItem(LOCALE_KEY, value); } catch { /* ignore */ }
}
