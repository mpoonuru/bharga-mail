import { describe, expect, it } from "vitest";

import { layoutMonthSpans, layoutTimedEvents } from "@/calendar/layout";

describe("calendar event layout", () => {
  it("places overlapping timed events in deterministic columns", () => {
    expect(
      layoutTimedEvents([
        { id: "b", start: "2026-03-10T09:30:00Z", end: "2026-03-10T10:30:00Z" },
        { id: "a", start: "2026-03-10T09:00:00Z", end: "2026-03-10T10:00:00Z" },
        { id: "c", start: "2026-03-10T11:00:00Z", end: "2026-03-10T12:00:00Z" },
      ]),
    ).toMatchObject([
      { id: "a", column: 0, columnCount: 2 },
      { id: "b", column: 1, columnCount: 2 },
      { id: "c", column: 0, columnCount: 1 },
    ]);
  });

  it("sorts equal starts by longest duration and then id", () => {
    expect(
      layoutTimedEvents([
        { id: "c", start: "2026-03-10T09:00:00Z", end: "2026-03-10T09:30:00Z" },
        { id: "b", start: "2026-03-10T09:00:00Z", end: "2026-03-10T11:00:00Z" },
        { id: "a", start: "2026-03-10T09:00:00Z", end: "2026-03-10T11:00:00Z" },
      ]).map(({ id, column }) => ({ id, column })),
    ).toEqual([
      { id: "a", column: 0 },
      { id: "b", column: 1 },
      { id: "c", column: 2 },
    ]);
  });

  it("splits multi-week spans without changing event identity", () => {
    expect(
      layoutMonthSpans(
        [{ id: "release", startDate: "2026-03-05", endDate: "2026-03-18" }],
        "2026-03-02",
        "2026-04-13",
      ),
    ).toEqual([
      {
        id: "release",
        segmentKey: "release:2026-03-05",
        weekIndex: 0,
        startColumn: 3,
        span: 4,
        startDate: "2026-03-05",
        endDateExclusive: "2026-03-09",
        continuesBefore: false,
        continuesAfter: true,
      },
      {
        id: "release",
        segmentKey: "release:2026-03-09",
        weekIndex: 1,
        startColumn: 0,
        span: 7,
        startDate: "2026-03-09",
        endDateExclusive: "2026-03-16",
        continuesBefore: true,
        continuesAfter: true,
      },
      {
        id: "release",
        segmentKey: "release:2026-03-16",
        weekIndex: 2,
        startColumn: 0,
        span: 2,
        startDate: "2026-03-16",
        endDateExclusive: "2026-03-18",
        continuesBefore: true,
        continuesAfter: false,
      },
    ]);
  });
});
