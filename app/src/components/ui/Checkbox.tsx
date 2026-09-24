import { forwardRef, useId, type InputHTMLAttributes } from "react";
import { AnimatePresence, motion } from "motion/react";
import { motionTransition, useMotionTransition } from "@/lib/motion";

// Ported from the Topup Arena (iTopup) design system: a custom checkbox with an
// animated SVG "draw" checkmark, sized variants, and an accessible hidden input.
export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "size"> {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  label?: string;
  description?: string;
  size?: "sm" | "md" | "lg";
}

const sizes = {
  sm: { box: 16, stroke: 2, text: "text-[13px]", desc: "text-[11px]" },
  md: { box: 20, stroke: 2.5, text: "text-[13px]", desc: "text-[11px]" },
  lg: { box: 24, stroke: 3, text: "text-[14px]", desc: "text-[12px]" },
};

function CheckMark({ size, stroke }: { size: number; stroke: number }) {
  const opacityTransition = useMotionTransition(motionTransition("instant"));
  const pathTransition = useMotionTransition(motionTransition("standard"));
  const p = size * 0.25;
  const d = `M${p} ${size / 2} L${size * 0.42} ${size - p} L${size - p} ${p}`;
  return (
    <motion.svg
      viewBox={`0 0 ${size} ${size}`}
      className="absolute inset-0"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={opacityTransition}
    >
      <motion.path
        d={d}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
        stroke="#fff"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        exit={{ pathLength: 0 }}
        transition={pathTransition}
      />
    </motion.svg>
  );
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { checked = false, onChange, label, description, size = "md", disabled, className, id, ...rest },
  ref
) {
  const generated = useId();
  const inputId = id || generated;
  const s = sizes[size];

  return (
    <label
      htmlFor={inputId}
      className={`group inline-flex gap-2.5 select-none ${description ? "items-start" : "items-center"} ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"} ${className || ""}`}
    >
      <input
        ref={ref}
        type="checkbox"
        id={inputId}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
        className="sr-only peer"
        {...rest}
      />
      <span
        className="relative flex-shrink-0 rounded-md border peer-focus-visible:ring-2 peer-focus-visible:ring-offset-1"
        style={{
          width: s.box,
          height: s.box,
          background: checked ? "var(--accent)" : "var(--surface)",
          borderColor: checked ? "var(--accent)" : "var(--border-2)",
          transition: "background-color var(--motion-standard) var(--ease), border-color var(--motion-standard) var(--ease)",
        }}
      >
        <AnimatePresence initial={false}>{checked && <CheckMark key="c" size={s.box} stroke={s.stroke} />}</AnimatePresence>
      </span>
      {(label || description) && (
        <span className={description ? "flex flex-col gap-0.5" : ""}>
          {label && <span className={`${s.text} font-medium`} style={{ color: "var(--text)" }}>{label}</span>}
          {description && <span className={s.desc} style={{ color: "var(--text-3)" }}>{description}</span>}
        </span>
      )}
    </label>
  );
});
