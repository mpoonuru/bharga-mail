// Shared keyboard predicates for composite controls that emulate button behavior.
export function isPrimaryActivationKey(key: string): boolean {
  return key === "Enter" || key === " ";
}

export function isKeyboardContextMenu(event: Pick<KeyboardEvent, "key" | "shiftKey">): boolean {
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
}
