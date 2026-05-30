import { useState } from "react";
import { events } from "@/data/mock";
import { useApp } from "@/store";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function CalendarView() {
  const createTask = useApp((s) => s.createTask);
  const [status, setStatus] = useState("");
  return (
    <>
      <h1>Calendar</h1>
      <p className="sub">Unified — Google, Microsoft 365 &amp; CalDAV. AI drafts events from your email.</p>

      <div className="cal-grid">
        {DAYS.map((d, i) => (
          <div className="cal-cell" key={d}>
            <div className="d">{d}</div>
            {events.filter((e) => e.day === i).map((e) => (
              <div className="cal-ev" key={e.id}>{e.time} · {e.title}</div>
            ))}
          </div>
        ))}
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="ai-summary" style={{ margin: 0 }}>
          <div className="lbl">✦ Scheduling assistant</div>
          <p>Marco asked to meet Thursday afternoon. You're free 14:00–16:00. <b>Propose Thursday 14:00?</b></p>
          <div className="chips">
            <button className="chip solid" onClick={() => { void createTask("Send invite to Marco — Thu 14:00"); setStatus("Invite queued as a task and added to Thursday."); }}>Send invite</button>
            <button className="chip" onClick={() => setStatus("Alternatives: Thu 15:00, Fri 10:00, Fri 14:30.")}>Suggest other times</button>
          </div>
          {status && <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>{status}</p>}
        </div>
      </div>
    </>
  );
}
