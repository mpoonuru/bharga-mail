import { useApp } from "@/store";

// Bottom-center "Sending… Undo" toast. The message is held in the outbox for a
// 10s window; Undo cancels it before it ever leaves.
export function UndoToast() {
  const { undo, cancelUndo, actionNotice } = useApp();
  if (!undo) {
    if (!actionNotice) return null;
    return (
      <div className="toast" role="status">
        <span>{actionNotice}</span>
      </div>
    );
  }
  return (
    <div className="toast">
      <span className="toast-spinner" />
      <span>{undo.label}</span>
      <button type="button" className="toast-undo" onClick={cancelUndo}>
        Undo
      </button>
    </div>
  );
}
