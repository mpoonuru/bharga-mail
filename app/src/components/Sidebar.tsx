import { motion } from "motion/react";
import { useApp } from "@/store";
import type { View } from "@/types";
import { Icon, type IconName } from "@/components/icons";
import { accountColor } from "@/lib/colors";
import logo from "@/assets/logo.png";

const NAV: { id: View; icon: IconName; label: string }[] = [
  { id: "priority", icon: "priority", label: "Priority" },
  { id: "inbox", icon: "inbox", label: "All Inbox" },
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

export function Sidebar({ rail = false }: { rail?: boolean }) {
  const { view, setView, setCompose, setModelPicker, threads, tasks, ai, accounts, selectedAccountId, setAccount } = useApp();
  const focused = selectedAccountId ? accounts.find((a) => a.id === selectedAccountId) : null;
  const headerAcct = focused?.email ?? (accounts.length > 1 ? "All accounts" : accounts[0]?.email ?? "No account connected");
  const count = (v: View) => threads.filter((t) => t.view.includes(v) && t.unread).length || undefined;
  const draftModel = ai?.models.find((m) => m.roles.includes("draft"));
  const triageModel = ai?.models.find((m) => m.roles.includes("triage"));

  const NavButton = ({ n, badge }: { n: { id: View; icon: IconName; label: string }; badge?: number }) => (
    <button
      className={`nav-item${view === n.id ? " active" : ""}`}
      onClick={() => setView(n.id)}
      title={rail ? n.label : undefined}
    >
      <span className="ic"><Icon name={n.icon} size={17} weight="duotone" /></span>
      {!rail && n.label}
      {!rail && badge ? <span className="count">{badge}</span> : null}
    </button>
  );

  return (
    <aside className={`sidebar${rail ? " rail" : ""}`}>
      <div className="brand" data-tauri-drag-region>
        <motion.img src={logo} alt="Aether Mail" className="logo" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 300, damping: 18 }} />
        {!rail && (
          <div style={{ minWidth: 0 }}>
            <b>Aether Mail</b>
            <div className="acct">{headerAcct}</div>
          </div>
        )}
      </div>

      <motion.button className="compose-btn" onClick={() => setCompose(true)} whileHover={{ y: -1 }} whileTap={{ scale: 0.97 }} title="Compose">
        <Icon name="compose" size={16} weight="bold" /> {!rail && "Compose"}
      </motion.button>

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
            <button
              key={a.id}
              className={`nav-item${selectedAccountId === a.id ? " active" : ""}`}
              onClick={() => setAccount(a.id)}
              title={a.email}
            >
              <span className="ic"><span className="acct-dot" style={{ background: accountColor(a.id) }} /></span>
              {!rail && <span className="acct-email">{a.email}</span>}
              {!rail && a.unread ? <span className="count">{a.unread}</span> : null}
            </button>
          ))}
        </>
      )}

      {!rail && <div className="nav-label">Bundles</div>}
      {BUNDLES.map((n) => <NavButton key={n.id} n={n} />)}

      {!rail && <div className="nav-label">Workspace</div>}
      {WORKSPACE.map((n) => <NavButton key={n.id} n={n} badge={n.id === "tasks" ? tasks.filter((t) => !t.done).length : undefined} />)}

      <div className="spacer" />

      <button className={`nav-item${view === "settings" ? " active" : ""}`} onClick={() => setView("settings")} title={rail ? "Settings" : undefined}>
        <span className="ic"><Icon name="settings" size={17} weight="duotone" /></span> {!rail && "Settings"}
      </button>

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
