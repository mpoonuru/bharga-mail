import { AVATAR_TINTS, AVATAR_GRADIENT_ANGLE } from "@/constants/avatarTints";

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

export interface AvatarPaint {
  /** light two-stop gradient for the tile background */
  bg: string;
  /** saturated mid-tone text/initials color */
  fg: string;
  /** subtle deeper-tint ring so the light tile reads on any background */
  ring: string;
}

/** A stable light-gradient avatar paint for a sender, hashed from a seed.
 *  The actual colors live in `src/constants/avatarTints.ts` — this just hashes
 *  the seed to a stable index and composes the gradient. Matches topup-arena's
 *  soft category-tile look (Tailwind 50→100 bg, 200 ring, 600 text). */
export function avatarColor(seed: string): AvatarPaint {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const tint = AVATAR_TINTS[h % AVATAR_TINTS.length];
  return {
    bg: `linear-gradient(${AVATAR_GRADIENT_ANGLE}, ${tint.bgFrom}, ${tint.bgTo})`,
    fg: tint.text,
    ring: tint.ring,
  };
}
