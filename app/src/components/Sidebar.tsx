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
  const { selectedAccountId, setAccount, folders, selectedFolder, setFolder, refreshFolders, pinnedFolders, togglePinFolder, threads } = useApp();
  const controls = useDragControls();
  const [busy, setBusy] = useState(false);
  const isFocused = selectedAccountId === a.id;
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
            return (
              <div className="folder-row" key={f.name}>
                <button className={`nav-item folder-item${selectedFolder === f.name ? " active" : ""}`} onClick={() => setFolder(f.name)} title={f.name}>
                  <span className="ic"><Icon name={FOLDER_ICON[f.role ?? ""] ?? "inbox"} size={15} weight="duotone" /></span>
                  <span className="acct-email">{f.role === "inbox" ? "Inbox" : f.name.replace(/^INBOX[./]/, "")}</span>
                  {(() => { const u = folderUnread(f.name); return u ? <span className="count">{u}</span> : null; })()}
                </button>
                <button className={`folder-pin${pinned ? " pinned" : ""}`} title={pinned ? "Unpin" : "Pin to top"}
                  onClick={(e) => { e.stopPropagation(); togglePinFolder(a.id, f.name); }}>
                  <Icon name="pin" size={11} weight={pinned ? "fill" : "regular"} />
                </button>
              </div>
            );
          })}
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
