import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useApp } from "@/store";
import { api } from "@/lib/bridge";
import type { View } from "@/types";
import { Icon, type IconName } from "@/components/icons";

interface Cmd { ic: IconName; label: string; hint?: string; run: () => void; }

export function CommandBar() {
  const { cmdOpen, setCmd, setView, setCompose, setModelPicker, toggleFocus, createTask, requestAiReply, threads, selectedThreadId } = useApp();
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (cmdOpen) {
      setQ(""); setAnswer(null);
      setTimeout(() => inputRef.current?.focus(), 40);
    }
  }, [cmdOpen]);

  const go = (v: View) => () => { setView(v); setCmd(false); };
  const commands: Cmd[] = [
    { ic: "reply", label: "Reply with AI draft", hint: "R", run: () => {
      if (selectedThreadId) requestAiReply(selectedThreadId);
      setCmd(false);
    } },
    { ic: "schedule", label: "Schedule a meeting from this thread", hint: "M", run: go("calendar") },
    { ic: "tasks", label: "Turn email into task", hint: "T", run: () => {
      const t = threads.find((x) => x.id === selectedThreadId);
      if (t) void createTask(`Follow up: ${t.subject}`, t.id);
      setView("tasks"); setCmd(false);
    } },
    { ic: "compose", label: "Compose new message", hint: "C", run: () => { setCompose(true); setCmd(false); } },
    { ic: "focus", label: "Toggle focus mode", hint: "F", run: () => { toggleFocus(); setCmd(false); } },
    { ic: "settings", label: "Switch AI model / engine", hint: "⌘\\", run: () => { setModelPicker(true); setCmd(false); } },
    { ic: "priority", label: "Go to Priority", run: go("priority") },
    { ic: "inbox", label: "Go to All Inbox", run: go("inbox") },
  ];
  const filtered = commands.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));

  async function ask() {
    setBusy(true);
    setAnswer(await api.askInbox(q));
    setBusy(false);
  }

  return (
    <AnimatePresence>
      {cmdOpen && (
        <motion.div
          className="cmd-overlay"
          onClick={(e) => { if (e.target === e.currentTarget) setCmd(false); }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <motion.div
            className="cmd"
            initial={{ y: -14, scale: 0.98, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: -10, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 26 }}
          >
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => { setQ(e.target.value); setAnswer(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") { q.trim().endsWith("?") || q.length > 18 ? ask() : filtered[0]?.run(); } }}
              placeholder="Type a command, search, or ask your inbox anything…"
            />

            {q && (
              <>
                <div className="sec">Ask AI</div>
                <div className="opt hi" onClick={ask}>
                  <span className="ic"><Icon name="ai" weight="duotone" /></span> Ask: “{q}”
                  <span className="hint">↵</span>
                </div>
              </>
            )}
            {busy && <div className="opt"><span className="ic"><Icon name="ai" weight="duotone" /></span> Thinking…</div>}
            {answer && <div className="opt" style={{ color: "var(--text-2)", display: "block" }}>{answer}</div>}

            <div className="sec">{q ? "Matching commands" : "Actions"}</div>
            {filtered.map((c) => (
              <div className="opt" key={c.label} onClick={c.run}>
                <span className="ic"><Icon name={c.ic} /></span> {c.label}
                {c.hint && <span className="hint">{c.hint}</span>}
              </div>
            ))}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
