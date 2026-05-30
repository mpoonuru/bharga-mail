import { useApp } from "@/store";
import { Checkbox } from "@/components/ui/Checkbox";
import { Tag } from "@/components/ui/Tag";

export function TasksView() {
  const { tasks, toggleTask } = useApp();
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);

  return (
    <>
      <h1>Tasks</h1>
      <p className="sub">Extracted from your email by AI, plus anything you add. One keystroke turns a thread into a task.</p>

      <div className="card glass-card">
        {open.map((t) => (
          <div className="task" key={t.id}>
            <Checkbox checked={false} onChange={() => toggleTask(t.id)} />
            <span className="t-title">{t.title}</span>
            {t.sourceThreadId && <Tag variant="ai" icon="ai">from email</Tag>}
            {t.due && <span className="t-meta">{t.due}</span>}
          </div>
        ))}
        {open.length === 0 && <div className="empty">All done. ✦</div>}
      </div>

      {done.length > 0 && (
        <>
          <p className="sub" style={{ marginTop: 18 }}>Completed</p>
          <div className="card glass-card">
            {done.map((t) => (
              <div className="task done" key={t.id}>
                <Checkbox checked={true} onChange={() => toggleTask(t.id)} />
                <span className="t-title">{t.title}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
