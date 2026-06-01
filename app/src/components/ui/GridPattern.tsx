import { useId } from "react";

/** SVG grid pattern (ported from topup-arena). Rendered skewed via a CSS class on
 *  the element to get the diagonal "slant line" texture; `squares` fills a few
 *  cells solid for subtle depth. */
interface GridPatternProps extends React.ComponentPropsWithoutRef<"svg"> {
  width: number;
  height: number;
  x: string | number;
  y: string | number;
  squares?: Array<[x: number, y: number]>;
}

export function GridPattern({ width, height, x, y, squares, ...props }: GridPatternProps) {
  const patternId = useId();
  return (
    <svg aria-hidden="true" {...props}>
      <defs>
        <pattern id={patternId} width={width} height={height} patternUnits="userSpaceOnUse" x={x} y={y}>
          <path d={`M.5 ${height}V.5H${width}`} fill="none" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" strokeWidth={0} fill={`url(#${patternId})`} />
      {squares && (
        <svg x={x} y={y} className="overflow-visible">
          {squares.map(([sqX, sqY]) => (
            <rect strokeWidth="0" key={`${sqX}-${sqY}`} width={width + 1} height={height + 1} x={sqX * width} y={sqY * height} />
          ))}
        </svg>
      )}
    </svg>
  );
}
