// Ensures unfinished calendar integrations are presented as example data.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CalendarView } from "@/components/CalendarView";

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("CalendarView", () => {
  it("labels example events as preview data", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(<CalendarView />));

    expect(host.textContent).toContain("Calendar preview");
    expect(host.textContent).toContain("Example events");
    expect(host.textContent).not.toContain("Unified — Google, Microsoft 365 & CalDAV");
  });
});
