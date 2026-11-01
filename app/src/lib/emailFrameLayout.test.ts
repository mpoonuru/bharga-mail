import { afterEach, describe, expect, it, vi } from "vitest";
import { bindEmailFrameLayout } from "./emailFrameLayout";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function originalCanvas() {
  const viewport = document.createElement("div");
  const frame = document.createElement("iframe");
  frame.style.border = "1px solid";
  frame.style.boxSizing = "border-box";
  viewport.appendChild(frame);
  document.body.appendChild(viewport);
  Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 500 });
  const doc = frame.contentDocument!;
  doc.body.innerHTML =
    '<table width="1100"><tr><td style="white-space:nowrap">10000.50</td></tr></table>';
  doc.body.style.padding = "20px 24px";
  Object.defineProperty(doc.body, "scrollWidth", { configurable: true, value: 1124 });
  Object.defineProperty(doc.body, "scrollHeight", { configurable: true, value: 600 });
  Object.defineProperty(doc.body, "offsetHeight", { configurable: true, value: 600 });
  const range = doc.createRange();
  Object.defineProperty(range, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      const scale = Number(doc.body.style.getPropertyValue("zoom")) || 1;
      return new DOMRect(24 * scale, 20 * scale, 1100 * scale, 560 * scale);
    },
  });
  vi.spyOn(doc, "createRange").mockReturnValue(range);
  const onSize = vi.fn();
  const binding = bindEmailFrameLayout(frame, viewport, { layout: "original", zoom: 100 }, onSize);
  cleanup.push(binding.dispose);
  return { binding, frame, viewport, body: doc.body, onSize };
}

describe("email canvas sizing", () => {
  it("includes the full original layout, padding, and border in its pan surface", () => {
    const { frame, onSize } = originalCanvas();
    expect(frame.style.width).toBe("1150px");
    expect(frame.style.height).toBe("602px");
    expect(onSize).toHaveBeenLastCalledWith({ width: 1150, viewportWidth: 500 });
  });

  it("scales the complete canvas and preserves the horizontal reading position", () => {
    const { binding, frame, viewport, body } = originalCanvas();
    viewport.scrollLeft = 200;
    binding.update({ layout: "original", zoom: 150 });
    expect(body.style.getPropertyValue("zoom")).toBe("1.5");
    expect(frame.style.width).toBe("1724px");
    expect(frame.style.height).toBe("902px");
    expect(viewport.scrollLeft).toBe(300);
    binding.update({ layout: "fit", zoom: 100 });
    expect(viewport.scrollLeft).toBe(0);
  });

  it("releases its style and ignores updates after disposal", () => {
    const { binding, frame, body } = originalCanvas();
    binding.dispose();
    const height = frame.style.height;
    binding.update({ layout: "original", zoom: 200 });
    expect(frame.style.height).toBe(height);
    expect(body.style.getPropertyValue("zoom")).toBe("1");
    expect(frame.contentDocument!.head.querySelector("[data-bharga-layout]")).toBeNull();
  });

  it("keeps table values unbroken and restores the sender's whitespace in Original layout", () => {
    const { binding, frame } = originalCanvas();
    const cell = frame.contentDocument!.querySelector("td")!;
    const style = () => frame.contentDocument!.defaultView!.getComputedStyle(cell);
    binding.update({ layout: "fit", zoom: 100 });
    expect(style().wordBreak).toBe("normal");
    expect(style().overflowWrap).toBe("normal");
    binding.update({ layout: "original", zoom: 100 });
    expect(style().whiteSpace).toBe("nowrap");
    expect(cell.textContent).toBe("10000.50");
  });
});
