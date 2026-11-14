import { afterEach, describe, expect, it } from "vitest";
import { UndoToast } from "@/components/UndoToast";
import { useApp } from "@/store";
import { renderTest } from "@/test/render";

afterEach(() => {
  useApp.setState({ actionNotice: null, undo: null });
});

describe("UndoToast action confirmation", () => {
  it("shows immediate confirmation for a completed thread action", () => {
    useApp.setState({ undo: null, actionNotice: "Archived" });
    const view = renderTest(<UndoToast />);

    expect(view.host.querySelector('[role="status"]')?.textContent).toBe("Archived");
    view.unmount();
  });
});
