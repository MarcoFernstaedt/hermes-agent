/**
 * Pure model for the agenda view — the accessible-first calendar surface.
 *
 * The spec is explicit that agenda is *first-class and complete*, not a lesser
 * fallback for a grid. So this is the primary date view: a linear, screen-reader
 * navigable sequence of day groups. A grid can be layered on later; nothing
 * depends on it.
 */

/** A record grouped under a day. */
export interface AgendaGroup<T> {
  /** ISO date key, `YYYY-MM-DD`. */
  key: string;
  /** Midnight of the day, for formatting. */
  date: Date;
  items: T[];
}

/** Parse a date-ish field value to a Date, or null when it isn't one. */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string" && value.trim()) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** `YYYY-MM-DD` in local time (not UTC — a day boundary is where the user is). */
export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Group records into ascending day buckets by a date field. Records whose date
 * is missing or unparseable are returned separately rather than silently
 * dropped — losing a record because a field was blank is a data-integrity bug
 * the user should be able to see.
 */
export function groupByDay<T extends Record<string, unknown>>(
  records: T[],
  field: string,
): { groups: AgendaGroup<T>[]; undated: T[] } {
  const buckets = new Map<string, { date: Date; items: T[] }>();
  const undated: T[] = [];

  for (const record of records) {
    const date = toDate(record[field]);
    if (!date) {
      undated.push(record);
      continue;
    }
    const key = dayKey(date);
    const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const bucket = buckets.get(key);
    if (bucket) bucket.items.push(record);
    else buckets.set(key, { date: midnight, items: [record] });
  }

  const groups = [...buckets.entries()]
    .map(([key, v]) => ({ key, date: v.date, items: v.items }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  return { groups, undated };
}

/** A human day label: "Today"/"Tomorrow"/"Yesterday" where it helps, else a date. */
export function dayLabel(date: Date, now: Date = new Date()): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((date.getTime() - today.getTime()) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays === -1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** True when the group is today — the one group worth accenting. */
export function isToday(date: Date, now: Date = new Date()): boolean {
  return dayKey(date) === dayKey(now);
}
