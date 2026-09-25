// Focused account center: health, connection, editing, and explicit removal flows.
import { useState } from "react";

import { AccountForm } from "@/components/AccountForm";
import { Icon } from "@/components/icons";
import { AccountRemovalDialog } from "@/components/settings/AccountRemovalDialog";
import { Modal } from "@/components/ui/Modal";
import { api, type ImapAccountInput } from "@/lib/bridge";
import { relativeUnixTime } from "@/lib/date";
import { useApp } from "@/store";
import type { Account } from "@/types";

type AccountOperation = {
  accountId: string;
  state: "syncing" | "success" | "error";
  message: string;
} | null;

interface AccountSettingsProps {
  runtime: "desktop" | "preview";
}

const PROVIDER_LABELS: Record<Account["provider"], string> = {
  gmail: "Gmail",
  microsoft: "Microsoft 365",
  jmap: "JMAP",
  imap: "IMAP",
};

export function AccountSettings({ runtime }: AccountSettingsProps) {
  const accounts = useApp((state) => state.accounts);
  const load = useApp((state) => state.load);
  const connectGmail = useApp((state) => state.connectGmail);
  const connectMicrosoft = useApp((state) => state.connectMicrosoft);
  const groupConversations = useApp((state) => state.groupConversations);
  const [operation, setOperation] = useState<AccountOperation>(null);
  const [menuAccountId, setMenuAccountId] = useState<string | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [imapOpen, setImapOpen] = useState(false);
  const [editAccount, setEditAccount] = useState<{ id: string; initial: Partial<ImapAccountInput> } | null>(null);
  const [removalAccount, setRemovalAccount] = useState<Account | null>(null);
  const [connectorError, setConnectorError] = useState("");

  async function syncAccount(account: Account) {
    if (operation?.state === "syncing") return;
    setOperation({ accountId: account.id, state: "syncing", message: "Syncing…" });
    try {
      await api.syncNow(account.id, groupConversations);
      await load();
      setOperation({ accountId: account.id, state: "success", message: "Up to date" });
    } catch (cause) {
      setOperation({
        accountId: account.id,
        state: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  async function connect(provider: "gmail" | "microsoft") {
    if (runtime !== "desktop") return;
    setConnectorError("");
    try {
      if (provider === "gmail") await connectGmail();
      else await connectMicrosoft();
      await load();
      setChooserOpen(false);
    } catch (cause) {
      setConnectorError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function openEdit(account: Account) {
    setMenuAccountId(null);
    try {
      const initial = await api.getImapAccount(account.id);
      if (!initial) throw new Error("Saved server settings are unavailable.");
      setEditAccount({ id: account.id, initial });
    } catch (cause) {
      setOperation({
        accountId: account.id,
        state: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return (
    <div className="settings-section account-settings">
      <div className="settings-section-head">
        <div>
          <h2>Accounts</h2>
          <p className="sub">Connect mailboxes and see their current sync health.</p>
        </div>
        <button type="button" className="af-btn primary" onClick={() => { setConnectorError(""); setChooserOpen(true); }}>
          <Icon name="plus" size={14} /> Add account
        </button>
      </div>

      {accounts.length === 0 ? (
        <div className="settings-empty account-empty">
          <Icon name="inbox" size={24} />
          <b>No accounts yet</b>
          <span>Add account to start syncing mail on this device.</span>
        </div>
      ) : (
        <div className="account-card-list">
          {accounts.map((account) => {
            const accountOperation = operation?.accountId === account.id ? operation : null;
            return (
              <article className="account-card" key={account.id}>
                <span className={`account-health-dot${accountOperation?.state === "error" ? " error" : ""}`} aria-hidden="true" />
                <div className="account-card-copy">
                  <div className="account-card-title">
                    <b>{account.displayName?.trim() || account.email}</b>
                    <span>{PROVIDER_LABELS[account.provider]}</span>
                  </div>
                  <p>{account.email}</p>
                  <div className="account-health-meta">
                    <span>{account.unread ? `${account.unread} unread` : "No unread mail"}</span>
                    <span>{account.lastSyncAt ? `Last synced ${relativeUnixTime(account.lastSyncAt)}` : "Not synced yet"}</span>
                  </div>
                  {accountOperation && (
                    <div className={`account-operation ${accountOperation.state}`} role={accountOperation.state === "error" ? "alert" : "status"}>
                      {accountOperation.message}
                    </div>
                  )}
                </div>
                <div className="account-card-actions">
                  <button type="button" className="af-btn ghost" disabled={accountOperation?.state === "syncing"} onClick={() => void syncAccount(account)}>
                    <Icon name="cloud" size={14} /> {accountOperation?.state === "syncing" ? "Syncing…" : "Sync"}
                  </button>
                  <button
                    type="button"
                    className="iconbtn"
                    aria-label={`More actions for ${account.displayName?.trim() || account.email}`}
                    aria-haspopup="menu"
                    aria-expanded={menuAccountId === account.id}
                    onClick={() => setMenuAccountId((open) => open === account.id ? null : account.id)}
                  >
                    <Icon name="more" size={17} />
                  </button>
                  {menuAccountId === account.id && (
                    <>
                      <button className="settings-menu-backdrop" aria-label="Close account menu" onClick={() => setMenuAccountId(null)} />
                      <div className="settings-menu" role="menu">
                        {account.provider === "imap" && (
                          <button type="button" role="menuitem" onClick={() => void openEdit(account)}><Icon name="compose" size={14} /> Edit server settings</button>
                        )}
                        <button type="button" role="menuitem" className="danger" onClick={() => { setMenuAccountId(null); setRemovalAccount(account); }}><Icon name="trash" size={14} /> Remove account</button>
                      </div>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <Modal open={chooserOpen} onClose={() => setChooserOpen(false)} title="Add mail account" maxWidth={560}>
        <div className="account-connector-list">
          <button type="button" disabled={runtime !== "desktop"} onClick={() => void connect("gmail")}>
            <Icon name="cloud" size={20} /><span><b>Gmail</b><small>{runtime === "desktop" ? "Sign in with Google" : "Desktop app required"}</small></span>
          </button>
          <button type="button" disabled={runtime !== "desktop"} onClick={() => void connect("microsoft")}>
            <Icon name="cloud" size={20} /><span><b>Microsoft 365</b><small>{runtime === "desktop" ? "Sign in with Microsoft" : "Desktop app required"}</small></span>
          </button>
          <button type="button" onClick={() => { setChooserOpen(false); setImapOpen(true); }}>
            <Icon name="server" size={20} /><span><b>Other IMAP / SMTP</b><small>Enter explicit incoming and outgoing servers</small></span>
          </button>
        </div>
        {connectorError && <div className="settings-alert error" role="alert">{connectorError}</div>}
      </Modal>

      <Modal open={imapOpen} onClose={() => setImapOpen(false)} title="Add IMAP / SMTP account">
        <AccountForm onClose={() => setImapOpen(false)} onStatus={() => { setImapOpen(false); setOperation(null); }} />
      </Modal>
      <Modal open={!!editAccount} onClose={() => setEditAccount(null)} title="Edit account">
        {editAccount && (
          <AccountForm editing initial={editAccount.initial} onClose={() => setEditAccount(null)} onStatus={() => setEditAccount(null)} />
        )}
      </Modal>
      {removalAccount && (
        <AccountRemovalDialog
          account={removalAccount}
          onClose={() => setRemovalAccount(null)}
          onRemoved={() => setOperation(null)}
        />
      )}
    </div>
  );
}
