import { useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { Reorder, useDragControls } from "motion/react";
import { useApp } from "@/store";
import type { View, Account } from "@/types";
import { Icon, type IconName } from "@/components/icons";
import { Tooltip } from "@/components/ui/Tooltip";
import { accountColor } from "@/lib/colors";
import { titlebarDoubleClick } from "@/lib/bridge";
import { MOTION, MOTION_EASE } from "@/lib/motion";
import { AccountRemovalDialog } from "@/components/settings/AccountRemovalDialog";
import { MeasuredDisclosure } from "@/components/ui/MeasuredDisclosure";
import { Modal } from "@/components/ui/Modal";

const NAV: { id: View; icon: IconName; label: string }[] = [
  { id: "priority", icon: "priority", label: "Priority" },
  { id: "inbox", icon: "inbox", label: "All Inbox" },
  { id: "flagged", icon: "flag", label: "Flagged" },
  { id: "snoozed", icon: "snoozed", label: "Snoozed" },
  { id: "awaiting", icon: "awaiting", label: "Awaiting reply" },
];
const BUNDLES: { id: View; icon: IconName; label: string }[] = [
  { id: "newsletters", icon: "newsletters", label: "Newsletters" },
  { id: "receipts", icon: "receipts", label: "Receipts" },
];
const WORKSPACE: { id: View; icon: IconName; label: string }[] = [
  { id: "calendar", icon: "calendar", label: "Calendar" },
  { id: "tasks", icon: "tasks", label: "Tasks" },
];

const FOLDER_ICON: Record<string, IconName> = {
  inbox: "inbox", sent: "send", drafts: "compose", trash: "close", junk: "close", archive: "awaiting",
};

// Pinned-folder key separator — must match the store's togglePinFolder (U+0001).
const PIN_SEP = "";
const pinKey = (accountId: string, folder: string) => `${accountId}${PIN_SEP}${folder}`;

export const ACCOUNT_DISCLOSURE_MOTION = {
  durationMs: MOTION.disclosure * 1000,
  caretDurationMs: 160,
  easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
} as const;

export const ACCOUNT_REORDER_MOTION = {
  idleLayout: false,
  activeLayout: "position",
  transition: {
    type: "tween",
    duration: MOTION.disclosure,
    ease: MOTION_EASE,
  },
} as const;

export function accountReorderLayout(active: boolean): false | "position" {
  return active ? ACCOUNT_REORDER_MOTION.activeLayout : ACCOUNT_REORDER_MOTION.idleLayout;
}

export function activateAccountReorder(commitActivation: () => void, startDrag: () => void): void {
  flushSync(commitActivation);
  startDrag();
}

type DisclosureStyle = CSSProperties & Record<`--${string}`, string>;

const ACCOUNT_ROW_MOTION_STYLE: DisclosureStyle = {
  "--account-caret-duration": `${ACCOUNT_DISCLOSURE_MOTION.caretDurationMs}ms`,
  "--account-disclosure-ease": ACCOUNT_DISCLOSURE_MOTION.easing,
};

/** A single account row in the expanded sidebar: drag-handle to reorder, the
 *  account selector, refresh, and (when focused) its folders with pin toggles. */
function AccountRow({ a, orderEditing, reordering, setReordering, onKeyboardMove }: {
  a: Account;
  orderEditing: boolean;
  reordering: boolean;
  setReordering: (active: boolean) => void;
  onKeyboardMove: (account: Account, direction: -1 | 1) => void;
}) {
  const { selectedAccountId, setAccount, folders, selectedFolder, setFolder, refreshFolders, pinnedFolders, togglePinFolder, threads, createFolder, renameFolder, deleteFolder, renameAccount, syncOneFolder, markFolderRead } = useApp();
  const controls = useDragControls();
  const [busy, setBusy] = useState(false);
  const isFocused = selectedAccountId === a.id;
  const isImap = a.provider === "imap";
  // Folder-management UI state.
  const [newName, setNewName] = useState<string | null>(null); // null = closed; "" = input open
  const [newParent, setNewParent] = useState<string | null>(null); // parent folder for a subfolder, else null = top level
  const [edit, setEdit] = useState<{ name: string; val: string } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [folderErr, setFolderErr] = useState("");
  // Account-level "⋯" menu + inline rename.
  const [acctMenu, setAcctMenu] = useState(false);
  const [acctRename, setAcctRename] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeReturnFocus, setRemoveReturnFocus] = useState<HTMLElement | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ name: string; label: string } | null>(null);
  const [deleteReturnFocus, setDeleteReturnFocus] = useState<HTMLElement | null>(null);
  const [deletingFolder, setDeletingFolder] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const accountMenuButtonRef = useRef<HTMLButtonElement>(null);
  const folderMenuButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const run = async (fn: () => Promise<void>) => {
    setFolderErr("");
    try { await fn(); } catch (e) { setFolderErr(String(e).replace(/^Error:\s*/, "")); }
  };
  // New folders nest like the account's existing ones ("INBOX." / "INBOX/" prefix).
  const sep = folders.find((f) => /^INBOX[./]/.test(f.name))?.name.match(/^INBOX([./])/)?.[1];
  const newPrefix = sep ? `INBOX${sep}` : "";
  const splitName = (full: string): [string, string] => {
    const m = full.match(/^(.*[./])([^./]+)$/);
    return m ? [m[1], m[2]] : ["", full];
  };
  // Live unread counts derived from threads (the cached AccountInfo/FolderInfo
  // counts are a sync-time snapshot and don't react to marking a mail read).
  const acctUnread = threads.filter((t) => t.accountId === a.id && t.unread).length;
  const folderUnread = (name: string) => threads.filter((t) => t.accountId === a.id && t.folder === name && t.unread).length;
  const confirmFolderDeletion = async () => {
    if (!deleteTarget || deletingFolder) return;
    setDeletingFolder(true);
    setDeleteError("");
    try {
      await deleteFolder(a.id, deleteTarget.name);
      setDeleteTarget(null);
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeletingFolder(false);
    }
  };
  return (
    <Reorder.Item
      value={a.id}
      as="div"
      dragListener={false}
      dragControls={controls}
      // ReorderItemProps narrows layout to true | "position", but the underlying
      // Motion runtime accepts false and defaults undefined to true. Keep the
      // upstream type mismatch isolated at this prop boundary.
      layout={accountReorderLayout(orderEditing && reordering) as true | "position"}
      transition={reordering ? { layout: ACCOUNT_REORDER_MOTION.transition } : undefined}
      onDragEnd={() => setReordering(false)}
      className="acct-reorder"
      style={ACCOUNT_ROW_MOTION_STYLE}
    >
      <div className="acct-row">
        {orderEditing && (
          <button
            className="acct-drag"
            title="Drag to reorder"
            aria-label={`Drag ${a.displayName?.trim() || a.email} to reorder`}
            aria-describedby="account-order-instructions"
            aria-keyshortcuts="ArrowUp ArrowDown"
            onKeyDown={(event) => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              onKeyboardMove(a, event.key === "ArrowUp" ? -1 : 1);
            }}
            onPointerDown={(e) => activateAccountReorder(
              () => setReordering(true),
              () => controls.start(e),
            )}
          >
            <Icon name="grip" size={13} weight="bold" />
          </button>
        )}
        {acctRename !== null ? (
          <input className="folder-edit" autoFocus value={acctRename} placeholder={a.email}
            onChange={(e) => setAcctRename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { const nm = acctRename.trim(); setAcctRename(null); if (nm) void run(() => renameAccount(a.id, nm)); }
              else if (e.key === "Escape") setAcctRename(null);
            }}
            onBlur={() => setAcctRename(null)} />
        ) : (
          <button className={`nav-item acct-main${isFocused ? " active" : ""}`}
            aria-expanded={isFocused}
            onClick={() => setAccount(isFocused ? null : a.id)} title={a.email}>
            <span className="ic"><span className="acct-dot" style={{ background: accountColor(a.id) }} /></span>
            <span className="acct-email">{a.displayName?.trim() || a.email}</span>
            <span className="acct-caret" aria-hidden="true">
              <Icon name="caretRight" size={11} weight="bold" />
            </span>
            {acctUnread ? <span className="count">{acctUnread}</span> : null}
          </button>
        )}
        {acctRename === null && (
          <button ref={accountMenuButtonRef} className={`acct-more${acctMenu ? " open" : ""}`} title={busy ? "Refreshing folders" : "Account options"}
            aria-haspopup="menu" aria-expanded={acctMenu}
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); setAcctMenu((o) => !o); }}>
            <Icon name={busy ? "cloud" : "more"} size={15} weight={busy ? "fill" : "bold"} />
          </button>
        )}
        {acctMenu && (
          <>
            <div className="folder-menu-backdrop" onClick={() => setAcctMenu(false)} aria-hidden="true" />
            <div className="folder-menu acct-menu" role="menu">
              {isImap && <button role="menuitem" onClick={() => { setAcctMenu(false); setAccount(a.id); setNewName(""); }}><Icon name="compose" size={12} /> New folder</button>}
              {isImap && <button role="menuitem" onClick={() => { setAcctMenu(false); setBusy(true); void refreshFolders(a.id).finally(() => setBusy(false)); }}><Icon name="cloud" size={12} /> Refresh folders</button>}
              <button role="menuitem" onClick={() => { setAcctMenu(false); setAcctRename(a.displayName?.trim() || ""); }}><Icon name="reply" size={12} /> Rename</button>
              <button role="menuitem" className="danger" onClick={() => {
                setRemoveReturnFocus(accountMenuButtonRef.current);
                setAcctMenu(false);
                setRemoveOpen(true);
              }}><Icon name="trash" size={12} /> Remove account</button>
            </div>
          </>
        )}
      </div>
      <MeasuredDisclosure
        open={isFocused}
        ariaLabel={`${a.displayName?.trim() || a.email} folders`}
        className="folder-disclosure"
        contentClassName="folder-disclosure-clip"
        durationMs={ACCOUNT_DISCLOSURE_MOTION.durationMs}
        easing={ACCOUNT_DISCLOSURE_MOTION.easing}
      >
        <div className="folder-tree">
          {(folders.length ? folders : [{ name: "INBOX", role: "inbox", unread: 0, total: 0 }]).map((f) => {
            const pinned = pinnedFolders.includes(pinKey(a.id, f.name));
            // Every IMAP folder gets a full options menu (Open / Sync / Mark all
            // read / New subfolder / Pin). Rename is offered for non-Inbox folders;
            // Delete only for CUSTOM ones (Inbox + Sent/Drafts/Trash/Junk protected).
            const manageable = isImap && f.role !== "inbox";
            const canDelete = isImap && !f.role;
            const editing = edit?.name === f.name;
            const [, leaf] = splitName(f.name);
            return (
              <div className="folder-row" key={f.name}
                onContextMenu={(e) => { if (isImap) { e.preventDefault(); setMenu(menu === f.name ? null : f.name); } }}>
                {editing ? (
                  <input className="folder-edit" autoFocus value={edit!.val}
                    onChange={(e) => setEdit({ name: f.name, val: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { const [pre] = splitName(f.name); const to = pre + edit!.val.trim(); const ok = edit!.val.trim() && to !== f.name; setEdit(null); if (ok) void run(() => renameFolder(a.id, f.name, to)); }
                      else if (e.key === "Escape") setEdit(null);
                    }}
                    onBlur={() => setEdit(null)} />
                ) : (
                  <button className={`nav-item folder-item${selectedFolder === f.name ? " active" : ""}`} onClick={() => setFolder(f.name)} title={f.name}>
                    <span className="ic"><Icon name={FOLDER_ICON[f.role ?? ""] ?? "inbox"} size={15} weight="duotone" /></span>
                    <span className="acct-email">{f.role === "inbox" ? "Inbox" : leaf}</span>
                    {(() => { const u = folderUnread(f.name); return u ? <span className="count">{u}</span> : null; })()}
                  </button>
                )}
                {/* Visible affordance — a hover "⋯" button so folder management
                    doesn't depend on a (non-obvious, WebView-flaky) right-click. */}
                {!editing && isImap && (
                  <button ref={(node) => {
                    if (node) folderMenuButtonRefs.current.set(f.name, node);
                    else folderMenuButtonRefs.current.delete(f.name);
                  }} className={`folder-more${menu === f.name ? " open" : ""}`} title="Folder options"
                    aria-haspopup="menu" aria-expanded={menu === f.name}
                    onClick={(e) => { e.stopPropagation(); setMenu(menu === f.name ? null : f.name); }}>
                    <Icon name="more" size={15} weight="bold" />
                  </button>
                )}
                {!editing && (
                  <button className={`folder-pin${pinned ? " pinned" : ""}`} title={pinned ? "Unpin" : "Pin to top"}
                    onClick={(e) => { e.stopPropagation(); togglePinFolder(a.id, f.name); }}>
                    <Icon name="pin" size={11} weight={pinned ? "fill" : "regular"} />
                  </button>
                )}
                {menu === f.name && isImap && (
                  <>
                    <div className="folder-menu-backdrop" onClick={() => setMenu(null)} aria-hidden="true" />
                    <div className="folder-menu" role="menu">
                      <button role="menuitem" onClick={() => { setMenu(null); void setFolder(f.name); }}><Icon name="inbox" size={12} /> Open</button>
                      <button role="menuitem" onClick={() => { setMenu(null); void run(() => syncOneFolder(a.id, f.name)); }}><Icon name="cloud" size={12} /> Sync now</button>
                      <button role="menuitem" onClick={() => { setMenu(null); void markFolderRead(a.id, f.name); }}><Icon name="envelopeOpen" size={12} /> Mark all as read</button>
                      <button role="menuitem" onClick={() => { setMenu(null); setNewParent(f.name); setNewName(""); }}><Icon name="compose" size={12} /> New subfolder</button>
                      <button role="menuitem" onClick={() => { setMenu(null); togglePinFolder(a.id, f.name); }}><Icon name="pin" size={12} /> {pinned ? "Unpin from top" : "Pin to top"}</button>
                      {manageable && <div className="folder-menu-sep" aria-hidden="true" />}
                      {manageable && <button role="menuitem" onClick={() => { setEdit({ name: f.name, val: leaf }); setMenu(null); }}><Icon name="reply" size={12} /> Rename</button>}
                      {canDelete && (
                        <button role="menuitem" className="danger" onClick={() => {
                          setDeleteReturnFocus(folderMenuButtonRefs.current.get(f.name) ?? null);
                          setMenu(null);
                          setDeleteError("");
                          setDeleteTarget({ name: f.name, label: leaf });
                        }}><Icon name="trash" size={12} /> Delete</button>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
          {isImap && (newName === null ? (
            <button className="folder-new" onClick={() => { setNewParent(null); setNewName(""); }} title="Create a new folder">
              <span className="ic"><Icon name="compose" size={13} weight="duotone" /></span> New folder
            </button>
          ) : (
            <input className="folder-edit" autoFocus value={newName}
              placeholder={newParent ? `New folder inside ${splitName(newParent)[1]}…` : "Folder name…"}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const nm = newName.trim();
                  const parent = newParent;
                  setNewName(null); setNewParent(null);
                  // Nest under the chosen parent (using the account's hierarchy
                  // delimiter), else create at the account's top level.
                  if (nm) void run(() => createFolder(a.id, (parent ? `${parent}${sep ?? "."}` : newPrefix) + nm));
                } else if (e.key === "Escape") { setNewName(null); setNewParent(null); }
              }}
              onBlur={() => { setNewName(null); setNewParent(null); }} />
          ))}
          {folderErr && <div className="folder-err" title={folderErr}>{folderErr}</div>}
        </div>
      </MeasuredDisclosure>
      {removeOpen && (
        <AccountRemovalDialog
          account={a}
          returnFocus={removeReturnFocus}
          fallbackFocus={document.querySelector<HTMLElement>(".compose-btn")}
          onClose={() => setRemoveOpen(false)}
          onRemoved={() => {
            setFolder(null);
            requestAnimationFrame(() => document.querySelector<HTMLElement>(".compose-btn")?.focus());
          }}
        />
      )}
      <Modal
        open={deleteTarget !== null}
        onClose={() => { if (!deletingFolder) setDeleteTarget(null); }}
        title="Delete folder"
        maxWidth={500}
        returnFocus={deleteReturnFocus}
        fallbackFocus={accountMenuButtonRef.current}
      >
        <div className="remove-account-dialog">
          <p>Delete <b>{deleteTarget?.label}</b> and its locally synced mail?</p>
          <p className="sub">This also requests deletion from the connected IMAP server and cannot be undone.</p>
          {deleteError && <div className="settings-alert error" role="alert">{deleteError}</div>}
          <div className="dialog-actions">
            <button type="button" className="af-btn ghost" disabled={deletingFolder} onClick={() => setDeleteTarget(null)}>Cancel</button>
            <button type="button" className="af-btn danger" disabled={deletingFolder} onClick={() => void confirmFolderDeletion()}>
              <Icon name="trash" size={14} /> {deletingFolder ? "Deleting…" : "Delete folder"}
            </button>
          </div>
        </div>
      </Modal>
    </Reorder.Item>
  );
}

export function Sidebar({ rail = false }: { rail?: boolean }) {
  const { view, setView, setCompose, setModelPicker, threads, tasks, ai, accounts, selectedAccountId, setAccount, selectedFolder, setFolder, toggleSidebar, accountOrder, setAccountOrder, pinnedFolders, togglePinFolder } = useApp();
  const [reordering, setReordering] = useState(false);
  const [orderEditing, setOrderEditing] = useState(false);
  const [orderAnnouncement, setOrderAnnouncement] = useState("");
  // Accounts in the user's saved order; any not yet in the order sort to the end.
  const ordered = [...accounts].sort((x, y) => {
    const ix = accountOrder.indexOf(x.id), iy = accountOrder.indexOf(y.id);
    if (ix === -1) return iy === -1 ? 0 : 1;
    if (iy === -1) return -1;
    return ix - iy;
  });
  const orderedIds = ordered.map((a) => a.id);
  const moveAccount = (account: Account, direction: -1 | 1) => {
    const from = orderedIds.indexOf(account.id);
    const to = Math.max(0, Math.min(from + direction, orderedIds.length - 1));
    if (from < 0 || from === to) return;
    const next = [...orderedIds];
    next.splice(from, 1);
    next.splice(to, 0, account.id);
    setAccountOrder(next);
    setOrderAnnouncement(`${account.displayName?.trim() || account.email} moved to position ${to + 1} of ${next.length}.`);
  };
  const count = (v: View) => threads.filter((t) => t.view.includes(v) && t.unread).length || undefined;
  const draftModel = ai?.models.find((m) => m.roles.includes("draft"));
  const triageModel = ai?.models.find((m) => m.roles.includes("triage"));

  const NavButton = ({ n, badge }: { n: { id: View; icon: IconName; label: string }; badge?: number }) => {
    const btn = (
      <button className={`nav-item${view === n.id && !selectedFolder ? " active" : ""}`} onClick={() => setView(n.id)}>
        <span className="ic"><Icon name={n.icon} size={17} weight="duotone" /></span>
        {!rail && n.label}
        {!rail && badge ? <span className="count">{badge}</span> : null}
      </button>
    );
    return rail ? <Tooltip label={n.label} block>{btn}</Tooltip> : btn;
  };

  return (
    <aside className={`sidebar${rail ? " rail" : ""}`}>
      <div className={`sidebar-top${rail ? " rail" : ""}`} data-tauri-drag-region onDoubleClick={titlebarDoubleClick}>
        <button className="rail-toggle" onClick={toggleSidebar} title={rail ? "Expand sidebar" : "Collapse sidebar"} aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}>
          <Icon name={rail ? "caretRight" : "caretLeft"} size={15} weight="bold" />
        </button>
      </div>

      {rail ? (
        <Tooltip label="Compose" block>
          <button className="compose-btn" onClick={() => setCompose(true)}>
            <Icon name="compose" size={16} weight="bold" />
          </button>
        </Tooltip>
      ) : (
        <button className="compose-btn" onClick={() => setCompose(true)}>
          <Icon name="compose" size={16} weight="bold" /> Compose
        </button>
      )}

      <div className="sidebar-scroll">
        {NAV.map((n) => <NavButton key={n.id} n={n} badge={count(n.id)} />)}

        {/* Pinned folders — quick jumps, kept at the top. */}
        {!rail && pinnedFolders.length > 0 && (
          <>
            <div className="nav-label">Pinned</div>
            {pinnedFolders.map((key) => {
              const [accId, folder] = key.split(PIN_SEP);
              const acc = accounts.find((a) => a.id === accId);
              if (!acc || !folder) return null;
              const active = selectedAccountId === accId && selectedFolder === folder;
              return (
                <div className="acct-row" key={key}>
                  <button
                    className={`nav-item acct-main folder-item${active ? " active" : ""}`}
                    onClick={() => { setAccount(accId); void setFolder(folder); }}
                    title={`${acc.email} · ${folder}`}
                  >
                    <span className="ic"><span className="acct-dot" style={{ background: accountColor(accId) }} /></span>
                    <span className="acct-email">{folder === "INBOX" ? "Inbox" : folder.replace(/^INBOX[./]/, "")}</span>
                  </button>
                  <button className="folder-pin pinned" title="Unpin" onClick={(e) => { e.stopPropagation(); togglePinFolder(accId, folder); }}>
                    <Icon name="pin" size={12} weight="fill" />
                  </button>
                </div>
              );
            })}
          </>
        )}

        {accounts.length > 0 && (
          <>
            {!rail && (
              <>
                <div className="nav-label nav-label-row">
                  <span>Accounts</span>
                  {accounts.length > 1 && (
                    <button
                      className="order-toggle"
                      type="button"
                      aria-pressed={orderEditing}
                      onClick={() => {
                        setOrderEditing((active) => !active);
                        setReordering(false);
                      }}
                    >
                      {orderEditing ? "Done" : "Edit order"}
                    </button>
                  )}
                </div>
                {orderEditing && (
                  <p className="account-order-instructions" id="account-order-instructions">
                    Drag the handles, or focus one and press Arrow Up or Arrow Down.
                  </p>
                )}
                <span className="sr-only" role="status" aria-live="polite">{orderAnnouncement}</span>
              </>
            )}
            {accounts.length > 1 && (
              <button
                className={`nav-item${selectedAccountId === null ? " active" : ""}`}
                onClick={() => setAccount(null)}
                title={rail ? "All accounts" : undefined}
              >
                <span className="ic"><Icon name="inbox" size={17} weight="duotone" /></span>
                {!rail && "All accounts"}
              </button>
            )}
            {rail ? (
              ordered.map((a) => (
                <button
                  key={a.id}
                  className={`nav-item${selectedAccountId === a.id ? " active" : ""}`}
                  onClick={() => setAccount(a.id)}
                  title={a.email}
                >
                  <span className="ic"><span className="acct-dot" style={{ background: accountColor(a.id) }} /></span>
                </button>
              ))
            ) : (
              <Reorder.Group axis="y" values={orderedIds} onReorder={setAccountOrder} as="div" className="acct-list">
                {ordered.map((a) => (
                  <AccountRow
                    key={a.id}
                    a={a}
                    orderEditing={orderEditing}
                    reordering={reordering}
                    setReordering={setReordering}
                    onKeyboardMove={moveAccount}
                  />
                ))}
              </Reorder.Group>
            )}
          </>
        )}

        {!rail && <div className="nav-label">Bundles</div>}
        {BUNDLES.map((n) => <NavButton key={n.id} n={n} />)}

        {!rail && <div className="nav-label">Workspace</div>}
        {WORKSPACE.map((n) => <NavButton key={n.id} n={n} badge={n.id === "tasks" ? tasks.filter((t) => !t.done).length : undefined} />)}
      </div>

      {(() => {
        const settingsBtn = (
          <button className={`nav-item${view === "settings" ? " active" : ""}`} onClick={() => setView("settings")}>
            <span className="ic"><Icon name="settings" size={17} weight="duotone" /></span> {!rail && "Settings"}
          </button>
        );
        return rail ? <Tooltip label="Settings" block>{settingsBtn}</Tooltip> : settingsBtn;
      })()}

      <button className="model-chip" onClick={() => setModelPicker(true)} title="AI engine">
        {rail ? (
          <div className="row" style={{ justifyContent: "center" }}><span className="dot" /></div>
        ) : (
          <>
            <div className="row"><span className="dot" /><b>{ai?.name ?? "AI engine"}</b></div>
            <small>Draft: {draftModel?.label ?? "—"} · Triage: {triageModel?.label ?? "—"}</small>
          </>
        )}
      </button>
    </aside>
  );
}
