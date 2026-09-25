// Provides engine-consistent disclosure motion without animating CSS grid tracks.
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type TransitionEvent,
} from "react";

type DisclosureStyle = CSSProperties & Record<`--${string}`, string>;

interface MeasuredDisclosureProps {
  open: boolean;
  ariaLabel: string;
  className: string;
  contentClassName: string;
  durationMs: number;
  easing: string;
  children: ReactNode;
}

export function MeasuredDisclosure({
  open,
  ariaLabel,
  className,
  contentClassName,
  durationMs,
  easing,
  children,
}: MeasuredDisclosureProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const measuredHeightRef = useRef(0);
  const [measuredHeight, setMeasuredHeight] = useState(0);
  const [settled, setSettled] = useState(false);

  const measure = useCallback(() => {
    const nextHeight = contentRef.current?.scrollHeight ?? 0;
    if (nextHeight === measuredHeightRef.current) return;
    measuredHeightRef.current = nextHeight;
    setSettled(false);
    setMeasuredHeight(nextHeight);
  }, []);

  // Measure after every committed child update. ResizeObserver then covers
  // width-driven wrapping, font loading, and other changes without a React render.
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(content);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);
  useLayoutEffect(() => setSettled(false), [open]);

  const style: DisclosureStyle = {
    height: `${open ? measuredHeight : 0}px`,
    "--measured-disclosure-duration": `${durationMs}ms`,
    "--measured-disclosure-ease": easing,
  };

  const handleTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.currentTarget !== event.target || event.propertyName !== "height") return;
    setSettled(open);
  };

  return (
    <div
      className={`${className}${open ? " expanded" : ""}${open && settled ? " settled" : ""}`}
      style={style}
      aria-label={ariaLabel}
      aria-hidden={!open}
      inert={!open}
      onTransitionEnd={handleTransitionEnd}
    >
      <div ref={contentRef} className={contentClassName}>
        {children}
      </div>
    </div>
  );
}
