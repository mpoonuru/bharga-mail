import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "@/components/ui/AppErrorBoundary";
import { renderTest } from "@/test/render";

function BrokenView(): ReactNode {
  throw new Error("test render failure");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AppErrorBoundary", () => {
  it("keeps a recovery action visible after a render failure", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    const view = renderTest(
      <AppErrorBoundary onReload={reload}>
        <BrokenView />
      </AppErrorBoundary>,
    );

    expect(view.host.textContent).toContain("Bharga Mail couldn’t display this view");
    const button = view.host.querySelector("button");
    act(() => button?.click());
    expect(reload).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("renders children when no failure occurs", () => {
    const view = renderTest(
      <AppErrorBoundary>
        <p>Inbox content</p>
      </AppErrorBoundary>,
    );

    expect(view.host.textContent).toBe("Inbox content");
    view.unmount();
  });
});
