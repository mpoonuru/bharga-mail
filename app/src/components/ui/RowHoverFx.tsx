import { motion, useMotionTemplate, type MotionValue } from "motion/react";
import { GridPattern } from "./GridPattern";

/** Premium hover treatment for list rows (adapted from topup-arena's product card):
 *  a faint skewed "slant line" grid that fades in on hover, plus a blue spotlight +
 *  brighter grid that track the cursor. Bharga's navy/blue palette, not topup green.
 *  Purely decorative — sits behind the row content and never eats pointer events.
 *  The parent row must be `position: relative` + `group` and own the mouse-move
 *  that drives `mouseX`/`mouseY`. */
export function RowHoverFx({ mouseX, mouseY }: { mouseX: MotionValue<number>; mouseY: MotionValue<number> }) {
  const mask = useMotionTemplate`radial-gradient(150px at ${mouseX}px ${mouseY}px, white, transparent)`;
  const maskStyle = { maskImage: mask, WebkitMaskImage: mask };
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Base slant-line grid — faint, fades in on row hover. */}
      <div className="absolute inset-0 opacity-0 transition duration-300 group-hover:opacity-100 [mask-image:linear-gradient(white,transparent)]">
        <GridPattern
          width={56} height={44} x="50%" y={-4} squares={[[0, 1], [1, 2]]}
          className="absolute inset-x-0 inset-y-[-30%] h-[160%] w-full skew-y-[-18deg] fill-[oklch(0.69_0.15_268/0.05)] stroke-[oklch(0.69_0.15_268/0.12)]"
        />
      </div>
      {/* Cursor spotlight — soft blue glow following the mouse. */}
      <motion.div
        style={maskStyle}
        className="absolute inset-0 bg-linear-to-r from-[oklch(0.70_0.12_262/0.20)] to-[oklch(0.74_0.10_215/0.16)] opacity-0 transition duration-300 group-hover:opacity-100"
      />
      {/* Cursor grid — brighter slant lines revealed only around the cursor. */}
      <motion.div style={maskStyle} className="absolute inset-0 opacity-0 mix-blend-overlay transition duration-300 group-hover:opacity-100">
        <GridPattern
          width={56} height={44} x="50%" y={-4} squares={[[0, 1], [1, 2]]}
          className="absolute inset-x-0 inset-y-[-30%] h-[160%] w-full skew-y-[-18deg] fill-[oklch(0.70_0.15_262/0.12)] stroke-[oklch(0.70_0.16_262/0.34)]"
        />
      </motion.div>
    </div>
  );
}
