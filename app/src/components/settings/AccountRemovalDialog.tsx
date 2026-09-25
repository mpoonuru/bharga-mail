// Shared destructive account-removal flow; success is reported only after store read-back.
import { useState } from "react";

import { Icon } from "@/components/icons";
import { Modal } from "@/components/ui/Modal";
import { useApp } from "@/store";
import type { Account } from "@/types";

interface AccountRemovalDialogProps {
  account: Account;
  onClose: () => void;
  onRemoved: () => void;
  returnFocus?: HTMLElement | null;
  fallbackFocus?: HTMLElement | null;
}

export function AccountRemovalDialog({ account, onClose, onRemoved, returnFocus, fallbackFocus }: AccountRemovalDialogProps) {
  const removeAccount = useApp((state) => state.removeAccount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await removeAccount(account.id);
      if (useApp.getState().accounts.some((candidate) => candidate.id === account.id)) {
        throw new Error("The account could not be removed completely. No success was reported.");
      }
      onRemoved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose(); }}
      title="Remove mail account"
      maxWidth={520}
      returnFocus={returnFocus}
      fallbackFocus={fallbackFocus}
    >
      <div className="remove-account-dialog">
        <p>Remove <b>{account.displayName?.trim() || account.email}</b> from Bharga Mail?</p>
        <p className="sub">Locally synced mail and saved credentials will be removed from this device. Mail on the server remains unchanged.</p>
        {error && <div className="settings-alert error" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="af-btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="af-btn danger" disabled={busy} onClick={() => void remove()}>
            <Icon name="trash" size={14} /> {busy ? "Removing…" : "Remove account"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
