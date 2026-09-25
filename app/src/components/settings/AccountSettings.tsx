// Focused account center: health, connection, editing, and explicit removal flows.
import { type KeyboardEvent, useRef, useState } from "react";

import { AccountForm } from "@/components/AccountForm";
import { Icon } from "@/components/icons";
import { AccountRemovalDialog } from "@/components/settings/AccountRemovalDialog";
import { Modal } from "@/components/ui/Modal";
import { api, type ImapAccountInput } from "@/lib/bridge";
import { relativeUnixTime } from "@/lib/date";
import { useApp } from "@/store";
import type { Account } from "@/types";

type AccountOperation = {
  state: "syncing" | "success" | "error";
  message: string;
  healthKey?: string;
};

interface AccountSettingsProps {
  runtime: "desktop" | "preview";
}

const PROVIDER_LABELS: Record<Account["provider"], string> = {
  gmail: "Gmail",
  microsoft: "Microsoft 365",
  jmap: "JMAP",
  imap: "IMAP",
};

const accountHealthKey = (account: Account | undefined) =>
  account ? `${account.lastSyncAt ?? ""}|${account.syncError ?? ""}` : "missing";

export function AccountSettings({ runtime }: AccountSettingsProps) {
  const accounts = useApp((state) => state.accounts);
  const load = useApp((state) => state.load);
  const connectGmail = useApp((state) => state.connectGmail);
  const connectMicrosoft = useApp((state) => state.connectMicrosoft);
  const groupConversations = useApp((state) => state.groupConversations);
  const [operations, setOperations] = useState<Record<string, AccountOperation>>({});
  const [menuAccountId, setMenuAccountId] = useState<string | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [imapOpen, setImapOpen] = useState(false);
  const [editAccount, setEditAccount] = useState<{ id: string; initial: Partial<ImapAccountInput>; returnFocus: HTMLElement | null } | null>(null);
  const [removalAccount, setRemovalAccount] = useState<{ account: Account; returnFocus: HTMLElement | null } | null>(null);
  const [connectorError, setConnectorError] = useState("");
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const accountMenuRefs = useRef(new Map<string, HTMLButtonElement>());
  const openMenuRef = useRef<HTMLDivElement>(null);

  const setOperation = (accountId: string, operation: AccountOperation | null) => {
    setOperations((current) => {
      if (operation) return { ...current, [accountId]: operation };
      const next = { ...current };
      delete next[accountId];
      return next;
    });
  };

  async function syncAccount(account: Account) {
    if (operations[account.id]?.state === "syncing") return;
    setOperation(account.id, { state: "syncing", message: "Syncing…" });
    try {
      await api.syncNow(account.id, groupConversations);
      await load();
      const refreshed = useApp.getState().accounts.find((candidate) => candidate.id === account.id);
      setOperation(account.id, { state: "success", message: "Up to date", healthKey: accountHealthKey(refreshed) });
    } catch (cause) {
      try {
        await load();
      } catch {
        // Preserve the provider failure when refreshing persisted health also fails.
      }
      const refreshed = useApp.getState().accounts.find((candidate) => candidate.id === account.id);
      setOperation(account.id, {
        state: "error",
        message: cause instanceof Error ? cause.message : String(cause),
        healthKey: accountHealthKey(refreshed),
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
    const returnFocus = accountMenuRefs.current.get(account.id) ?? null;
    setMenuAccountId(null);
    try {
      const initial = await api.getImapAccount(account.id);
      if (!initial) throw new Error("Saved server settings are unavailable.");
      setEditAccount({ id: account.id, initial, returnFocus });
    } catch (cause) {
      setOperation(account.id, {
        state: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  function toggleAccountMenu(accountId: string) {
    if (menuAccountId === accountId) {
      setMenuAccountId(null);
      return;
    }
    setMenuAccountId(accountId);
    requestAnimationFrame(() => openMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>, accountId: string) {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === "ArrowDown") next = (current + 1) % items.length;
    else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      setMenuAccountId(null);
      accountMenuRefs.current.get(accountId)?.focus();
      return;
    } else if (event.key === "Tab") {
      setMenuAccountId(null);
      return;
    } else {
      return;
    }
    event.preventDefault();
    items[next]?.focus();
  }

  return (
    <div className="settings-section account-settings">
      <div className="settings-section-head">
        <div>
          <h2>Accounts</h2>
          <p className="sub">Connect mailboxes and see their current sync health.</p>
        </div>
        <button ref={addButtonRef} type="button" className="af-btn primary" onClick={() => { setConnectorError(""); setChooserOpen(true); }}>
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
            const storedOperation = operations[account.id] ?? null;
            const persistedHealthChanged = storedOperation?.state !== "syncing"
              && storedOperation?.healthKey !== undefined
              && storedOperation.healthKey !== accountHealthKey(account);
            const accountOperation = persistedHealthChanged ? null : storedOperation;
            return (
              <article className="account-card" key={account.id}>
                <span className={`account-health-dot${accountOperation?.state === "error" || account.syncError ? " error" : account.lastSyncAt ? "" : " neutral"}`} aria-hidden="true" />
                <div className="account-card-copy">
                  <div className="account-card-title">
                    <b>{account.displayName?.trim() || account.email}</b>
                    <span>{PROVIDER_LABELS[account.provider]}</span>
                  </div>
                  <p>{account.email}</p>
                  <div className="account-health-meta">
                    <span>{account.unread ? `${account.unread} unread` : "No unread mail"}</span>
                    <span>{account.syncError ?? (account.lastSyncAt ? `Last synced ${relativeUnixTime(account.lastSyncAt)}` : "Not synced yet")}</span>
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
                    ref={(node) => {
                      if (node) accountMenuRefs.current.set(account.id, node);
                      else accountMenuRefs.current.delete(account.id);
                    }}
                    type="button"
                    className="iconbtn"
                    aria-label={`More actions for ${account.displayName?.trim() || account.email}`}
                    aria-haspopup="menu"
                    aria-expanded={menuAccountId === account.id}
                    onClick={() => toggleAccountMenu(account.id)}
                  >
                    <Icon name="more" size={17} />
                  </button>
                  {menuAccountId === account.id && (
                    <>
                      <button className="settings-menu-backdrop" tabIndex={-1} aria-hidden="true" onClick={() => setMenuAccountId(null)} />
                      <div ref={openMenuRef} className="settings-menu" role="menu" onKeyDown={(event) => handleMenuKeyDown(event, account.id)}>
                        {account.provider === "imap" && (
                          <button type="button" role="menuitem" onClick={() => void openEdit(account)}><Icon name="compose" size={14} /> Edit server settings</button>
                        )}
                        <button type="button" role="menuitem" className="danger" onClick={() => {
                          const returnFocus = accountMenuRefs.current.get(account.id) ?? null;
                          setMenuAccountId(null);
                          setRemovalAccount({ account, returnFocus });
                        }}><Icon name="trash" size={14} /> Remove account</button>
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
        <AccountForm onClose={() => setImapOpen(false)} onStatus={() => setImapOpen(false)} />
      </Modal>
      <Modal
        open={!!editAccount}
        onClose={() => setEditAccount(null)}
        title="Edit account"
        returnFocus={editAccount?.returnFocus ?? null}
        fallbackFocus={addButtonRef.current}
      >
        {editAccount && (
          <AccountForm editing accountId={editAccount.id} initial={editAccount.initial} onClose={() => setEditAccount(null)} onStatus={() => setEditAccount(null)} />
        )}
      </Modal>
      {removalAccount && (
        <AccountRemovalDialog
          account={removalAccount.account}
          returnFocus={removalAccount.returnFocus}
          fallbackFocus={addButtonRef.current}
          onClose={() => setRemovalAccount(null)}
          onRemoved={() => {
            setOperation(removalAccount.account.id, null);
            requestAnimationFrame(() => addButtonRef.current?.focus());
          }}
        />
      )}
    </div>
  );
}
