// Per-account colors in OKLCH. All swatches share the same lightness/chroma and
// differ only in hue, so they're perceptually even and harmonious — exactly what
// OKLCH is good at. Each account is mapped to a stable color by hashing its id.

const ACCOUNT_HUES = [268, 330, 18, 70, 152, 200, 300, 120];
const L = 0.7;
const C = 0.15;

export function accountColor(id: string, alpha = 1): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = ACCOUNT_HUES[h % ACCOUNT_HUES.length];
  return alpha < 1 ? `oklch(${L} ${C} ${hue} / ${alpha})` : `oklch(${L} ${C} ${hue})`;
}

/** A subtle gradient for avatars, derived from the account's hue. */
export function accountGradient(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = ACCOUNT_HUES[h % ACCOUNT_HUES.length];
  return `linear-gradient(135deg, oklch(0.72 0.15 ${hue}), oklch(0.66 0.16 ${(hue + 40) % 360}))`;
}
