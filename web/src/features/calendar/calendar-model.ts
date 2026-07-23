/**
 * Pure date/grouping helpers for the agenda view. No React — unit-tested.
 */
import type { CalendarEvent } from "@/lib/api";

export function isAllDay(e: CalendarEvent): boolean {
  return !!e.start.date && !e.start.dateTime;
}

export function eventStart(e: CalendarEvent): Date {
  return new Date(e.start.dateTime ?? `${e.start.date}T00:00:00`);
}

export function eventEnd(e: CalendarEvent): Date {
  return new Date(e.end.dateTime ?? `${e.end.date}T00:00:00`);
}

/** Local YYYY-MM-DD key for grouping. */
export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface AgendaDay {
  key: string;
  date: Date;
  events: CalendarEvent[];
}

/** Group events into day buckets, each sorted by start time, buckets ascending. */
export function groupByDay(events: CalendarEvent[]): AgendaDay[] {
  const buckets = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const key = dayKey(eventStart(e));
    const arr = buckets.get(key) ?? [];
    arr.push(e);
    buckets.set(key, arr);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, evs]) => ({
      key,
      date: new Date(`${key}T00:00:00`),
      events: evs.sort((a, b) => eventStart(a).getTime() - eventStart(b).getTime()),
    }));
}

export function formatEventTime(e: CalendarEvent): string {
  if (isAllDay(e)) return "All day";
  const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  const s = eventStart(e).toLocaleTimeString([], opts);
  const en = eventEnd(e).toLocaleTimeString([], opts);
  return `${s} – ${en}`;
}

/** "Today", "Tomorrow", or a weekday+date label, plus the full date. */
export function formatDayHeading(date: Date, now: Date = new Date()): { label: string; sub: string } {
  const dk = dayKey(date);
  const today = dayKey(now);
  const tomorrow = dayKey(new Date(now.getTime() + 86400000));
  let label: string;
  if (dk === today) label = "Today";
  else if (dk === tomorrow) label = "Tomorrow";
  else label = date.toLocaleDateString([], { weekday: "long" });
  const sub = date.toLocaleDateString([], { month: "short", day: "numeric" });
  return { label, sub };
}

/** [start, end) ISO window covering `days` from local midnight today. */
export function agendaWindow(days = 14, now: Date = new Date()): { min: string; max: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start.getTime() + days * 86400000);
  return { min: start.toISOString(), max: end.toISOString() };
}
