// Keeps About metadata derived while preserving creator and contributor attribution.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AboutSettings } from "@/components/settings/AboutSettings";

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("AboutSettings", () => {
  it("renders the runtime version, creator credit, and contributor credit", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(<AboutSettings version="0.1.3" runtime="preview" />));

    expect(host.textContent).toContain("Version 0.1.3");
    expect(host.textContent).toContain("Created by");
    expect(host.textContent).toContain("Arjun P");
    expect(host.textContent).toContain("Maintained with");
    expect(host.textContent).toContain("Bharga Mail contributors");
    expect(host.textContent).toContain("Preview runtime");
  });
});
