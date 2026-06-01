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

// A wider hue wheel for per-sender avatars (each correspondent gets a stable
// color). Topup-arena style: a LIGHT gradient tile (≈ Tailwind 50→100) with
// saturated mid-tone text (≈ 600) and a slightly deeper hairline ring (≈ 200).
const AVATAR_HUES = [268, 312, 348, 18, 45, 72, 110, 152, 192, 232];

export interface AvatarPaint {
  /** light two-stop gradient for the tile background */
  bg: string;
  /** saturated mid-tone text/initials color */
  fg: string;
  /** subtle deeper-tint ring so the light tile reads on any background */
  ring: string;
}

/** A stable light-gradient avatar paint for a sender, hashed from a seed. */
export function avatarColor(seed: string): AvatarPaint {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = AVATAR_HUES[h % AVATAR_HUES.length];
  const hue2 = (hue + 22) % 360; // slight hue rotation between stops for a richer, visible gradient
  return {
    // Wider lightness/chroma spread + a hue shift so the gradient actually reads
    // (topup-arena category-tile style) instead of looking like a flat tint.
    bg: `linear-gradient(140deg, oklch(0.95 0.06 ${hue}), oklch(0.83 0.13 ${hue2}))`,
    fg: `oklch(0.47 0.16 ${hue})`,
    ring: `oklch(0.83 0.10 ${hue})`,
  };
}
