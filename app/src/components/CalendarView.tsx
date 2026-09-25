import { useEffect, useState } from "react";
import { useApp } from "@/store";
import { api } from "@/lib/bridge";
import type { CalendarEvent } from "@/types";
import dayjs from "dayjs";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function CalendarView() {
  const createTask = useApp((s) => s.createTask);
  const [status, setStatus] = useState("");
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const today = dayjs();
  const weekStart = today.subtract((today.day() + 6) % 7, "day").startOf("day");
  const weekStartIso = weekStart.toISOString();

  useEffect(() => {
    let active = true;
    void api.calendar.listEvents({
      start: weekStartIso,
      end: dayjs(weekStartIso).add(7, "day").toISOString(),
    }).then((next) => {
      if (active) setEvents(next);
    }).catch(() => {
      if (active) setStatus("Calendar data could not be loaded.");
    });
    return () => { active = false; };
  }, [weekStartIso]);

  const eventDay = (event: CalendarEvent) => {
    const value = event.start.kind === "timed" ? event.start.utc : event.start.date;
    return dayjs(value).startOf("day").diff(weekStart, "day");
  };
  const eventTime = (event: CalendarEvent) =>
    event.start.kind === "timed" ? dayjs(event.start.utc).format("HH:mm") : "All day";

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h1 style={{ marginBottom: 0 }}>Calendar preview</h1>
        <span className="tag">Preview</span>
      </div>
      <p className="sub">Example events show the planned calendar experience. No calendar provider is connected.</p>

      <div className="cal-grid">
        {DAYS.map((d, i) => (
          <div className="cal-cell" key={d}>
            <div className="d">{d}</div>
            {events.filter((event) => eventDay(event) === i).map((event) => (
              <div className="cal-ev" key={event.id}>{eventTime(event)} · {event.title}</div>
            ))}
          </div>
        ))}
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="ai-summary" style={{ margin: 0 }}>
          <div className="lbl">✦ Scheduling assistant · Example events</div>
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
