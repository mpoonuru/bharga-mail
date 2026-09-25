// Behavioral coverage for responsive settings navigation and keyboard destination selection.
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { SettingsShell } from "@/components/settings/SettingsShell";
import { renderTest } from "@/test/render";

describe("SettingsShell", () => {
  it("exposes seven keyboard-complete settings destinations", () => {
    const onChange = vi.fn();
    const { host, unmount } = renderTest(
      <SettingsShell active="accounts" onChange={onChange}>
        <p>Accounts panel</p>
      </SettingsShell>,
    );

    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      "Accounts",
      "Appearance",
      "AI and privacy",
      "Signatures",
      "Security and data",
      "Diagnostics",
      "About",
    ]);
    expect(buttons[0].getAttribute("aria-selected")).toBe("true");
    expect(buttons[0].tabIndex).toBe(0);
    expect(buttons.slice(1).every((button) => button.tabIndex === -1)).toBe(true);
    expect(host.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
    expect(host.querySelector('[role="tabpanel"]')?.textContent).toContain("Accounts panel");
    expect(host.querySelector('[role="tablist"]')?.classList.contains("settings-nav")).toBe(true);

    act(() => buttons[0].click());
    expect(onChange).toHaveBeenCalledWith("accounts");

    act(() => buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith("appearance");

    act(() => buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith("about");

    act(() => buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith("about");

    act(() => buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith("accounts");

    unmount();
  });
});
