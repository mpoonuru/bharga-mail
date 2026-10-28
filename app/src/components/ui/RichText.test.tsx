// Responsive toolbar coverage: control dividers must never wrap as standalone lines.
import { afterEach, describe, expect, it, vi } from "vitest";

import { RichText } from "@/components/ui/RichText";
import { renderTest } from "@/test/render";

afterEach(() => {
  document.body.replaceChildren();
});

describe("RichText", () => {
  it("keeps toolbar dividers attached to non-wrapping control groups", async () => {
    const rendered = renderTest(<RichText />);

    await vi.waitFor(() => expect(rendered.host.querySelector(".rt-toolbar")).not.toBeNull());

    const toolbar = rendered.host.querySelector(".rt-toolbar");
    expect(toolbar?.querySelectorAll(":scope > .rt-sep")).toHaveLength(0);
    expect(toolbar?.querySelectorAll(":scope > .rt-tool-group").length).toBeGreaterThan(1);
  });
});
