// Shared focus-boundary helpers for modal dialogs and other contained surfaces.
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[contenteditable="true"]',
  "[tabindex]",
].join(",");

function isUnavailable(node: HTMLElement, container: HTMLElement): boolean {
  if (node.tabIndex < 0) return true;
  let current: HTMLElement | null = node;
  while (current) {
    if (
      current.hidden
      || current.hasAttribute("inert")
      || current.getAttribute("aria-hidden") === "true"
    ) return true;
    const style = getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return true;
    if (current === container) break;
    current = current.parentElement;
  }
  return false;
}

export function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((node) => !isUnavailable(node, container));
}

export function containTabKey(event: KeyboardEvent, container: HTMLElement): void {
  if (event.key !== "Tab") return;
  const items = focusableElements(container);
  if (items.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
