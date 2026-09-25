/** Behavioral coverage for safe, discoverable invitation actions in mail. */

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InvitationCard } from "@/calendar/InvitationCard";
import type { InvitationInspection } from "@/types";
import { renderTest } from "@/test/render";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const inspection: InvitationInspection = {
  state: "new",
  method: "REQUEST",
  transport: "emailAttachment",
  conflicts: [],
  event: {
    id: "incoming",
    calendarId: "calendar-1",
    uid: "planning@example.test",
    providerId: null,
    title: "Planning review",
    description: "",
    location: "Berlin",
    conferenceUrl: null,
    sourceThreadId: null,
    start: { kind: "timed", utc: "2026-09-25T12:00:00Z" },
    end: { kind: "timed", utc: "2026-09-25T13:00:00Z" },
    timezone: "Europe/Berlin",
    recurrence: null,
    recurrenceId: null,
    parentEventId: null,
    status: "confirmed",
    transparency: "busy",
    visibility: "default",
    organizer: { name: "Marco", email: "marco@example.test" },
    attendees: [],
    reminders: [],
    sequence: 3,
    providerVersion: null,
    revision: 1,
    syncState: "pending",
    deleted: false,
  },
};

describe("InvitationCard", () => {
  it("shows provenance, normalized time, and all RSVP actions", () => {
    const onRespond = vi.fn();
    const rendered = renderTest(<InvitationCard inspection={inspection} timezone="Europe/Berlin" onRespond={onRespond} />);
    cleanup = rendered.unmount;

    expect(document.body.textContent).toContain("Planning review");
    expect(document.body.textContent).toContain("Marco");
    expect(document.body.textContent).toContain("Europe/Berlin");
    expect(document.body.textContent).toContain("Email calendar attachment");
    const accept = [...document.querySelectorAll("button")].find((button) => button.textContent === "Accept");
    act(() => accept?.click());
    expect(onRespond).toHaveBeenCalledWith("accepted");
  });

  it("does not offer RSVP actions for a stale invitation", () => {
    const rendered = renderTest(<InvitationCard inspection={{ ...inspection, state: "stale" }} timezone="UTC" onRespond={() => {}} />);
    cleanup = rendered.unmount;
    expect(document.body.textContent).toMatch(/newer version/i);
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Accept")).toBe(false);
  });
});
