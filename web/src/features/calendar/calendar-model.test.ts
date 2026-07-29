import { describe, expect, it } from "vitest";

import {
  agendaWindow,
  dayKey,
  formatDayHeading,
  groupByDay,
  isAllDay,
} from "./calendar-model";
import type { CalendarEvent } from "@/lib/api";

function ev(id: string, start: string, end: string, allDay = false): CalendarEvent {
  return allDay
    ? { id, start: { date: start }, end: { date: end } }
    : { id, start: { dateTime: start }, end: { dateTime: end } };
}

describe("calendar-model", () => {
  it("detects all-day events", () => {
    expect(isAllDay(ev("1", "2026-07-24", "2026-07-25", true))).toBe(true);
    expect(isAllDay(ev("2", "2026-07-24T09:00:00", "2026-07-24T10:00:00"))).toBe(false);
  });

  it("groups events by day, sorted within and across days", () => {
    const events = [
      ev("late", "2026-07-24T15:00:00", "2026-07-24T16:00:00"),
      ev("early", "2026-07-24T09:00:00", "2026-07-24T10:00:00"),
      ev("nextday", "2026-07-25T08:00:00", "2026-07-25T09:00:00"),
    ];
    const days = groupByDay(events);
    expect(days.map((d) => d.key)).toEqual(["2026-07-24", "2026-07-25"]);
    expect(days[0].events.map((e) => e.id)).toEqual(["early", "late"]);
  });

  it("labels today and tomorrow", () => {
    const now = new Date("2026-07-24T12:00:00");
    expect(formatDayHeading(new Date("2026-07-24T00:00:00"), now).label).toBe("Today");
    expect(formatDayHeading(new Date("2026-07-25T00:00:00"), now).label).toBe("Tomorrow");
  });

  it("agendaWindow spans the requested days from local midnight", () => {
    const now = new Date("2026-07-24T18:00:00");
    const { min, max } = agendaWindow(7, now);
    expect(dayKey(new Date(min))).toBe("2026-07-24");
    // 7 days later
    expect(dayKey(new Date(max))).toBe("2026-07-31");
  });
});
