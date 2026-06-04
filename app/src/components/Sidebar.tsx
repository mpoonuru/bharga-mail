import { useState } from "react";
import { motion, Reorder, useDragControls } from "motion/react";
import { useApp } from "@/store";
import type { View, Account } from "@/types";
import { Icon, type IconName } from "@/components/icons";
import { Tooltip } from "@/components/ui/Tooltip";
import { accountColor } from "@/lib/colors";
import { titlebarDoubleClick } from "@/lib/bridge";

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

/** A single account row in the expanded sidebar: drag-handle to reorder, the
 *  account selector, refresh, and (when focused) its folders with pin toggles. */
function AccountRow({ a }: { a: Account }) {
  const { selectedAccountId, setAccount, folders, selectedFolder, setFolder, refreshFolders, pinnedFolders, togglePinFolder, threads, createFolder, renameFolder, deleteFolder } = useApp();
  const controls = useDragControls();
  const [busy, setBusy] = useState(false);
  const isFocused = selectedAccountId === a.id;
  const isImap = a.provider === "imap";
  // Folder-management UI state.
  const [newName, setNewName] = useState<string | null>(null); // null = closed; "" = input open
  const [edit, setEdit] = useState<{ name: string; val: string } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [folderErr, setFolderErr] = useState("");
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
  return (
    <Reorder.Item value={a.id} as="div" dragListener={false} dragControls={controls} layout="position" className="acct-reorder">
      <div className="acct-row">
        <button className="acct-drag" title="Drag to reorder" aria-label="Drag to reorder" onPointerDown={(e) => controls.start(e)}>
          <Icon name="grip" size={13} weight="bold" />
        </button>
        <button className={`nav-item acct-main${isFocused ? " active" : ""}`} onClick={() => setAccount(a.id)} title={a.email}>
          <span className="ic"><span className="acct-dot" style={{ background: accountColor(a.id) }} /></span>
          <span className="acct-email">{a.email}</span>
          {acctUnread ? <span className="count">{acctUnread}</span> : null}
        </button>
        {a.provider === "imap" && (
          <button className="acct-refresh" title="Refresh folders" disabled={busy}
            onClick={async (e) => { e.stopPropagation(); setBusy(true); try { await refreshFolders(a.id); } finally { setBusy(false); } }}>
            <Icon name="cloud" size={13} weight={busy ? "fill" : "duotone"} />
          </button>
        )}
      </div>
      {isFocused && (
        <div className="folder-tree">
          {(folders.length ? folders : [{ name: "INBOX", role: "inbox", unread: 0, total: 0 }]).map((f) => {
            const pinned = pinnedFolders.includes(pinKey(a.id, f.name));
            // Every folder except the Inbox gets a right-click menu. Rename is always
            // offered; Delete only for CUSTOM folders (so Sent/Drafts/Trash/Junk —
            // the special ones — can't be deleted by accident).
            const manageable = isImap && f.role !== "inbox";
            const canDelete = isImap && !f.role;
            const editing = edit?.name === f.name;
            const [, leaf] = splitName(f.name);
            return (
              <div className="folder-row" key={f.name}
                onContextMenu={(e) => { if (manageable) { e.preventDefault(); setMenu(menu === f.name ? null : f.name); } }}>
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
                {!editing && (
                  <button className={`folder-pin${pinned ? " pinned" : ""}`} title={pinned ? "Unpin" : "Pin to top"}
                    onClick={(e) => { e.stopPropagation(); togglePinFolder(a.id, f.name); }}>
                    <Icon name="pin" size={11} weight={pinned ? "fill" : "regular"} />
                  </button>
                )}
                {menu === f.name && manageable && (
                  <div className="folder-menu" onMouseLeave={() => setMenu(null)} role="menu">
                    <button role="menuitem" onClick={() => { setEdit({ name: f.name, val: leaf }); setMenu(null); }}><Icon name="reply" size={12} /> Rename</button>
                    {canDelete && (
                      <button role="menuitem" className="danger" onClick={() => { setMenu(null); if (window.confirm(`Delete folder “${leaf}” and the mail in it? This can't be undone.`)) void run(() => deleteFolder(a.id, f.name)); }}><Icon name="trash" size={12} /> Delete</button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {isImap && (newName === null ? (
            <button className="folder-new" onClick={() => setNewName("")} title="Create a new folder">
              <span className="ic"><Icon name="compose" size={13} weight="duotone" /></span> New folder
            </button>
          ) : (
            <input className="folder-edit" autoFocus placeholder="Folder name…" value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { const nm = newName.trim(); setNewName(null); if (nm) void run(() => createFolder(a.id, newPrefix + nm)); }
                else if (e.key === "Escape") setNewName(null);
              }}
              onBlur={() => setNewName(null)} />
          ))}
          {folderErr && <div className="folder-err" title={folderErr}>{folderErr}</div>}
        </div>
      )}
    </Reorder.Item>
  );
}

export function Sidebar({ rail = false }: { rail?: boolean }) {
  const { view, setView, setCompose, setModelPicker, threads, tasks, ai, accounts, selectedAccountId, setAccount, selectedFolder, setFolder, toggleSidebar, accountOrder, setAccountOrder, pinnedFolders, togglePinFolder } = useApp();
  // Accounts in the user's saved order; any not yet in the order sort to the end.
  const ordered = [...accounts].sort((x, y) => {
    const ix = accountOrder.indexOf(x.id), iy = accountOrder.indexOf(y.id);
    if (ix === -1) return iy === -1 ? 0 : 1;
    if (iy === -1) return -1;
    return ix - iy;
  });
  const orderedIds = ordered.map((a) => a.id);
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
          <motion.button className="compose-btn" onClick={() => setCompose(true)} whileHover={{ y: -1 }} whileTap={{ scale: 0.97 }}>
            <Icon name="compose" size={16} weight="bold" />
          </motion.button>
        </Tooltip>
      ) : (
        <motion.button className="compose-btn" onClick={() => setCompose(true)} whileHover={{ y: -1 }} whileTap={{ scale: 0.97 }}>
          <Icon name="compose" size={16} weight="bold" /> Compose
        </motion.button>
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
            {!rail && <div className="nav-label">Accounts</div>}
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
                {ordered.map((a) => <AccountRow key={a.id} a={a} />)}
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

      <motion.button className="model-chip" onClick={() => setModelPicker(true)} whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }} title="AI engine">
        {rail ? (
          <div className="row" style={{ justifyContent: "center" }}><span className="dot" /></div>
        ) : (
          <>
            <div className="row"><span className="dot" /><b>{ai?.name ?? "AI engine"}</b></div>
            <small>Draft: {draftModel?.label ?? "—"} · Triage: {triageModel?.label ?? "—"}</small>
          </>
        )}
      </motion.button>
    </aside>
  );
}
