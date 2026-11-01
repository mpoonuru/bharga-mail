import { AVATAR_GRADIENT_ANGLE, AVATAR_TINTS } from "@/constants/avatarTints";

// Per-account colors in OKLCH. All swatches share the same lightness/chroma and
// differ only in hue, so they're perceptually even and harmonious — exactly what
// OKLCH is good at. Each account is mapped to a stable color by hashing its id.
const L = 0.7;
const C = 0.15;

/** Named presets for the manual per-account color picker (enterprise swatch
 *  pattern). The eight hues are ~45° apart so neighbours stay distinguishable
 *  at dot size, and each name matches what its swatch actually looks like. */
export interface AccountColorChoice {
  /** Stable key persisted in settings; "auto" keeps the deterministic hash. */
  key: string;
  name: string;
  /** OKLCH hue, or null for "auto". */
  hue: number | null;
}

export const ACCOUNT_COLOR_CHOICES: readonly AccountColorChoice[] = [
  { key: "auto", name: "Auto", hue: null },
  { key: "red", name: "Red", hue: 25 },
  { key: "amber", name: "Amber", hue: 70 },
  { key: "lime", name: "Lime", hue: 115 },
  { key: "emerald", name: "Emerald", hue: 155 },
  { key: "teal", name: "Teal", hue: 200 },
  { key: "blue", name: "Blue", hue: 245 },
  { key: "violet", name: "Violet", hue: 295 },
  { key: "rose", name: "Rose", hue: 335 },
];

/** The eight manual hues — also the auto-hash buckets, so manual and automatic
 *  colors come from the exact same set. */
const ACCOUNT_HUES = ACCOUNT_COLOR_CHOICES.filter((choice) => choice.hue !== null).map(
  (choice) => choice.hue as number,
);

export function accountColorFromHue(hue: number, alpha = 1): string {
  return alpha < 1 ? `oklch(${L} ${C} ${hue} / ${alpha})` : `oklch(${L} ${C} ${hue})`;
}

export function accountColor(id: string, alpha = 1): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return accountColorFromHue(ACCOUNT_HUES[h % ACCOUNT_HUES.length], alpha);
}

/** Resolve an account dot color from a persisted choice key; missing/unknown/"auto"
 *  falls back to the stable hash so every account always has a color. */
export function resolveAccountColor(id: string, choiceKey: string | undefined): string {
  if (!choiceKey || choiceKey === "auto") return accountColor(id);
  const choice = ACCOUNT_COLOR_CHOICES.find((c) => c.key === choiceKey);
  return choice && choice.hue !== null ? accountColorFromHue(choice.hue) : accountColor(id);
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
