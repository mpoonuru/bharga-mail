// Verifies the reusable dialog focus boundary independently from React rendering.
import { describe, expect, it } from "vitest";
import { containTabKey, focusableElements } from "@/lib/focus";

describe("dialog focus helpers", () => {
  it("excludes hidden and disabled controls", () => {
    const host = document.createElement("div");
    host.innerHTML = '<button>First</button><button disabled>Disabled</button><a href="#">Last</a>';

    expect(focusableElements(host).map((node) => node.textContent)).toEqual(["First", "Last"]);
  });

  it("wraps Shift+Tab from the first control to the last", () => {
    const host = document.createElement("div");
    host.innerHTML = '<button>First</button><button>Last</button>';
    document.body.append(host);
    const [first, last] = focusableElements(host);
    first.focus();
    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true });

    containTabKey(event, host);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    host.remove();
  });
});
