import { useApp } from "@/store";

// Bottom-center "Sending… Undo" toast. The message is held in the outbox for a
// 10s window; Undo cancels it before it ever leaves.
export function UndoToast() {
  const { undo, cancelUndo } = useApp();
  if (!undo) return null;
  return (
    <div className="toast">
      <span className="toast-spinner" />
      <span>{undo.label}</span>
      <button className="toast-undo" onClick={cancelUndo}>Undo</button>
    </div>
  );
}
