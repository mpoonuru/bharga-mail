import { useState } from "react";
import { motion } from "motion/react";
import { useApp } from "@/store";
import type { View } from "@/types";
import { Icon, type IconName } from "@/components/icons";
import { Tooltip } from "@/components/ui/Tooltip";
import { accountColor } from "@/lib/colors";
import logo from "@/assets/logo.png";

const NAV: { id: View; icon: IconName; label: string }[] = [
  { id: "priority", icon: "priority", label: "Priority" },
  { id: "inbox", icon: "inbox", label: "All Inbox" },
  { id: "flagged", icon: "priority", label: "Flagged" },
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

export function Sidebar({ rail = false }: { rail?: boolean }) {
  const { view, setView, setCompose, setModelPicker, threads, tasks, ai, accounts, selectedAccountId, setAccount, folders, selectedFolder, setFolder, refreshFolders, sidebarCollapsed, toggleSidebar } = useApp();
  const [foldersBusy, setFoldersBusy] = useState(false);
  const focused = selectedAccountId ? accounts.find((a) => a.id === selectedAccountId) : null;
  const headerAcct = focused?.email ?? (accounts.length > 1 ? "All accounts" : accounts[0]?.email ?? "No account connected");
  const count = (v: View) => threads.filter((t) => t.view.includes(v) && t.unread).length || undefined;
  const draftModel = ai?.models.find((m) => m.roles.includes("draft"));
  const triageModel = ai?.models.find((m) => m.roles.includes("triage"));

  const NavButton = ({ n, badge }: { n: { id: View; icon: IconName; label: string }; badge?: number }) => {
    const btn = (
      <button className={`nav-item${view === n.id ? " active" : ""}`} onClick={() => setView(n.id)}>
        <span className="ic"><Icon name={n.icon} size={17} weight="duotone" /></span>
        {!rail && n.label}
        {!rail && badge ? <span className="count">{badge}</span> : null}
      </button>
    );
    return rail ? <Tooltip label={n.label}>{btn}</Tooltip> : btn;
  };

  return (
    <aside className={`sidebar${rail ? " rail" : ""}`}>
      <div className="brand" data-tauri-drag-region>
        <motion.img src={logo} alt="Aether Mail" className="logo" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 300, damping: 18 }} />
        {!rail && (
          <div style={{ minWidth: 0, flex: 1 }}>
            <b>Aether Mail</b>
            <div className="acct">{headerAcct}</div>
          </div>
        )}
        <button className="rail-toggle" onClick={toggleSidebar} title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}>
          <Icon name={rail ? "caretRight" : "caretLeft"} size={14} weight="bold" />
        </button>
      </div>

      {rail ? (
        <Tooltip label="Compose">
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
            {accounts.map((a) => (
              <div key={a.id}>
                <div className="acct-row">
                  <button
                    className={`nav-item acct-main${selectedAccountId === a.id ? " active" : ""}`}
                    onClick={() => setAccount(a.id)}
                    title={a.email}
                  >
                    <span className="ic"><span className="acct-dot" style={{ background: accountColor(a.id) }} /></span>
                    {!rail && <span className="acct-email">{a.email}</span>}
                    {!rail && a.unread ? <span className="count">{a.unread}</span> : null}
                  </button>
                  {!rail && a.provider === "imap" && (
                    <button
                      className="acct-refresh"
                      title="Refresh folders"
                      disabled={foldersBusy}
                      onClick={async (e) => { e.stopPropagation(); setFoldersBusy(true); try { await refreshFolders(a.id); } finally { setFoldersBusy(false); } }}
                    >
                      <Icon name="cloud" size={13} weight={foldersBusy ? "fill" : "duotone"} />
                    </button>
                  )}
                </div>
                {/* Folders for the focused account (always shows at least Inbox). */}
                {!rail && selectedAccountId === a.id && (
                  <div className="folder-tree">
                    {(folders.length ? folders : [{ name: "INBOX", role: "inbox", unread: 0, total: 0 }]).map((f) => (
                      <button
                        key={f.name}
                        className={`nav-item folder-item${selectedFolder === f.name ? " active" : ""}`}
                        onClick={() => setFolder(f.name)}
                        title={f.name}
                      >
                        <span className="ic"><Icon name={FOLDER_ICON[f.role ?? ""] ?? "inbox"} size={15} weight="duotone" /></span>
                        <span className="acct-email">{f.role === "inbox" ? "Inbox" : f.name.replace(/^INBOX[./]/, "")}</span>
                        {f.unread ? <span className="count">{f.unread}</span> : null}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
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
        return rail ? <Tooltip label="Settings">{settingsBtn}</Tooltip> : settingsBtn;
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
