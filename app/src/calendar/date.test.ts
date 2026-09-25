import { describe, expect, it } from "vitest";

import { allDayLabel, calendarRange, monthCells, weekDays } from "@/calendar/date";

describe("calendar date math", () => {
  it("keeps an all-day event on its source dates in every viewer timezone", () => {
    expect(
      allDayLabel(
        { startDate: "2026-10-25", endDate: "2026-10-26" },
        "America/Los_Angeles",
      ),
    ).toEqual({ start: "2026-10-25", endExclusive: "2026-10-26" });
  });

  it("derives a complete ISO-week month grid across DST", () => {
    const cells = monthCells("2026-03-15", "Europe/Berlin");

    expect(cells).toHaveLength(42);
    expect(cells[0]?.date).toBe("2026-02-23");
    expect(cells.at(-1)?.date).toBe("2026-04-05");
    expect(new Set(cells.map((cell) => cell.date)).size).toBe(42);
  });

  it("returns timezone-aware bounded query ranges", () => {
    expect(calendarRange("2026-03-15", "week", "Europe/Berlin")).toEqual({
      start: "2026-03-08T23:00:00.000Z",
      end: "2026-03-15T23:00:00.000Z",
    });
    expect(calendarRange("2026-03-15", "agenda", "Europe/Berlin")).toEqual({
      start: "2026-03-14T23:00:00.000Z",
      end: "2026-04-13T22:00:00.000Z",
    });
  });

  it("returns seven stable date-only week values", () => {
    expect(weekDays("2026-03-15", "America/New_York").map((day) => day.date)).toEqual([
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
      "2026-03-12",
      "2026-03-13",
      "2026-03-14",
      "2026-03-15",
    ]);
  });
});
