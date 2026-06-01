import { useState } from "react";
import dayjs from "dayjs";
import { Icon } from "@/components/icons";

/** A compact "Send later" popover: quick presets + a custom date/time picker.
 *  Calls `onSchedule` with an absolute epoch in **seconds**. */
export function SendLater({ onSchedule, disabled }: { onSchedule: (epochSeconds: number) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");

  // Next weekday (1 = Monday) at a given hour, always in the future.
  const nextWeekdayAt = (isoWeekday: number, hour: number) => {
    let d = dayjs().hour(hour).minute(0).second(0);
    while (d.day() !== isoWeekday % 7 || d.isBefore(dayjs())) d = d.add(1, "day");
    return d;
  };
  const presets: { label: string; at: dayjs.Dayjs }[] = [
    { label: "In 1 hour", at: dayjs().add(1, "hour") },
    { label: "This evening", at: (dayjs().hour() < 18 ? dayjs().hour(18) : dayjs().add(1, "day").hour(18)).minute(0).second(0) },
    { label: "Tomorrow morning", at: dayjs().add(1, "day").hour(8).minute(0).second(0) },
    { label: "Monday morning", at: nextWeekdayAt(1, 8) },
  ];

  const pick = (at: dayjs.Dayjs) => { onSchedule(at.unix()); setOpen(false); setCustom(""); };

  return (
    <span className="sendlater">
      <button type="button" className="iconbtn" title="Send later" disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <Icon name="schedule" size={15} weight="duotone" />
      </button>
      {open && (
        <>
          <div className="sendlater-backdrop" onClick={() => setOpen(false)} />
          <div className="sendlater-menu" role="menu">
            <div className="sendlater-head">Schedule send</div>
            {presets.map((p) => (
              <button key={p.label} role="menuitem" className="sendlater-opt" onClick={() => pick(p.at)}>
                <span>{p.label}</span>
                <span className="sendlater-when">{p.at.format("ddd HH:mm")}</span>
              </button>
            ))}
            <div className="sendlater-sep" />
            <label className="sendlater-custom">
              <span>Pick date & time</span>
              <input
                type="datetime-local"
                value={custom}
                min={dayjs().format("YYYY-MM-DDTHH:mm")}
                onChange={(e) => setCustom(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="sendlater-schedule"
              disabled={!custom || dayjs(custom).isBefore(dayjs())}
              onClick={() => custom && pick(dayjs(custom))}
            >
              <Icon name="schedule" size={13} weight="duotone" /> Schedule
            </button>
            <p className="sendlater-note">Sends while Bharga is running on this device.</p>
          </div>
        </>
      )}
    </span>
  );
}
