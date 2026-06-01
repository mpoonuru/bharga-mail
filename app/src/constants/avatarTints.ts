/**
 * Avatar tint palette — the soft "light gradient" used for sender avatars.
 *
 * This mirrors topup-arena's category / avatar tiles (their
 * `constants/gradients.ts`): a Tailwind 50 → 100 gradient with a 200 hairline
 * ring and 600 text. We express it in OKLCH so the whole set shares ONE
 * perceptual lightness/chroma curve and only the hue changes per color — that
 * is what gives the calm, uniform pastel feel of the navbar tiles.
 *
 * Design intent: this file is pure DATA. Tuning a color, adding a palette, or
 * shifting the whole curve lighter/darker is an edit *here* — the render code
 * in `src/lib/colors.ts` never hardcodes a color value.
 *
 * Shared curve (matches topup-arena's globals.css), per hue `H`:
 *   50  → oklch(0.97 0.02 H)   gradient start (bgFrom)
 *   100 → oklch(0.94 0.05 H)   gradient end   (bgTo)
 *   200 → oklch(0.88 0.10 H)   hairline ring  (ring)
 *   600 → oklch(0.55 0.15 H)   initials/text  (text)
 */

/** Gradient angle for every avatar tile. topup uses Tailwind `to-br` = 135°. */
export const AVATAR_GRADIENT_ANGLE = "135deg";

export interface AvatarTint {
  /** Palette name — for readability/debugging only, never rendered. */
  name: string;
  /** ≈ Tailwind 50 — gradient start. */
  bgFrom: string;
  /** ≈ Tailwind 100 — gradient end. */
  bgTo: string;
  /** ≈ Tailwind 200 — hairline ring so the light tile reads on any surface. */
  ring: string;
  /** ≈ Tailwind 600 — initials / icon color. */
  text: string;
}

/**
 * Twelve hues spread evenly around the wheel (warm → cool), each rendered on
 * the shared 50/100/200/600 curve above. Mirrors the color families used by
 * topup-arena's avatar/category tiles (rose, orange, amber, lime, emerald,
 * teal, cyan, sky, blue, indigo, violet, fuchsia).
 */
export const AVATAR_TINTS: readonly AvatarTint[] = [
  { name: "rose",    bgFrom: "oklch(0.97 0.02 16)",  bgTo: "oklch(0.94 0.05 16)",  ring: "oklch(0.88 0.10 16)",  text: "oklch(0.55 0.15 16)" },
  { name: "orange",  bgFrom: "oklch(0.97 0.02 55)",  bgTo: "oklch(0.94 0.05 55)",  ring: "oklch(0.88 0.10 55)",  text: "oklch(0.55 0.15 55)" },
  { name: "amber",   bgFrom: "oklch(0.97 0.02 80)",  bgTo: "oklch(0.94 0.05 80)",  ring: "oklch(0.88 0.10 80)",  text: "oklch(0.55 0.15 80)" },
  { name: "lime",    bgFrom: "oklch(0.97 0.02 130)", bgTo: "oklch(0.94 0.05 130)", ring: "oklch(0.88 0.10 130)", text: "oklch(0.55 0.15 130)" },
  { name: "emerald", bgFrom: "oklch(0.97 0.02 160)", bgTo: "oklch(0.94 0.05 160)", ring: "oklch(0.88 0.10 160)", text: "oklch(0.55 0.15 160)" },
  { name: "teal",    bgFrom: "oklch(0.97 0.02 180)", bgTo: "oklch(0.94 0.05 180)", ring: "oklch(0.88 0.10 180)", text: "oklch(0.55 0.15 180)" },
  { name: "cyan",    bgFrom: "oklch(0.97 0.02 210)", bgTo: "oklch(0.94 0.05 210)", ring: "oklch(0.88 0.10 210)", text: "oklch(0.55 0.15 210)" },
  { name: "sky",     bgFrom: "oklch(0.97 0.02 237)", bgTo: "oklch(0.94 0.05 237)", ring: "oklch(0.88 0.10 237)", text: "oklch(0.55 0.15 237)" },
  { name: "blue",    bgFrom: "oklch(0.97 0.02 255)", bgTo: "oklch(0.94 0.05 255)", ring: "oklch(0.88 0.10 255)", text: "oklch(0.55 0.15 255)" },
  { name: "indigo",  bgFrom: "oklch(0.97 0.02 277)", bgTo: "oklch(0.94 0.05 277)", ring: "oklch(0.88 0.10 277)", text: "oklch(0.55 0.15 277)" },
  { name: "violet",  bgFrom: "oklch(0.97 0.02 293)", bgTo: "oklch(0.94 0.05 293)", ring: "oklch(0.88 0.10 293)", text: "oklch(0.55 0.15 293)" },
  { name: "fuchsia", bgFrom: "oklch(0.97 0.02 322)", bgTo: "oklch(0.94 0.05 322)", ring: "oklch(0.88 0.10 322)", text: "oklch(0.55 0.15 322)" },
];
