// Verifies that tooltip-wrapped icon controls remain named for assistive technology.
import { afterEach, describe, expect, it } from "vitest";
import { Tooltip } from "@/components/ui/Tooltip";
import { renderTest } from "@/test/render";

afterEach(() => {
  document.body.replaceChildren();
});

describe("Tooltip", () => {
  it("gives an unlabeled icon button the tooltip label as its accessible name", () => {
    const rendered = renderTest(
      <Tooltip label="Compose">
        <button type="button"><span aria-hidden="true">+</span></button>
      </Tooltip>,
    );

    expect(rendered.host.querySelector("button")?.getAttribute("aria-label")).toBe("Compose");
  });

  it("preserves an explicit accessible name supplied by the control", () => {
    const rendered = renderTest(
      <Tooltip label="Open actions">
        <button type="button" aria-label="Account actions">…</button>
      </Tooltip>,
    );

    expect(rendered.host.querySelector("button")?.getAttribute("aria-label")).toBe("Account actions");
  });
});
