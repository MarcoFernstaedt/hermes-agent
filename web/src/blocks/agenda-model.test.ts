import { describe, expect, it } from "vitest";
import { dayKey, dayLabel, groupByDay, isToday, toDate } from "./agenda-model";

const rec = (id: string, due: unknown) => ({ id, due });

describe("toDate", () => {
  it("accepts ISO strings, timestamps and Dates", () => {
    expect(toDate("2026-03-04")).toBeInstanceOf(Date);
    expect(toDate(1_700_000_000_000)).toBeInstanceOf(Date);
    expect(toDate(new Date("2026-03-04"))).toBeInstanceOf(Date);
  });

  it("rejects blanks and nonsense rather than inventing a date", () => {
    expect(toDate("")).toBeNull();
    expect(toDate("   ")).toBeNull();
    expect(toDate("not a date")).toBeNull();
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate(new Date("nope"))).toBeNull();
  });
});

describe("groupByDay", () => {
  it("buckets by local day, ascending", () => {
    const { groups } = groupByDay(
      [
        rec("c", "2026-03-06T09:00:00"),
        rec("a", "2026-03-04T09:00:00"),
        rec("b", "2026-03-05T09:00:00"),
      ],
      "due",
    );
    expect(groups.map((g) => g.key)).toEqual(["2026-03-04", "2026-03-05", "2026-03-06"]);
  });

  it("keeps same-day records together in one group", () => {
    const { groups } = groupByDay(
      [rec("a", "2026-03-04T09:00:00"), rec("b", "2026-03-04T18:30:00")],
      "due",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("surfaces undated records instead of dropping them", () => {
    const { groups, undated } = groupByDay(
      [rec("a", "2026-03-04"), rec("b", ""), rec("c", null)],
      "due",
    );
    expect(groups).toHaveLength(1);
    expect(undated.map((r) => r.id)).toEqual(["b", "c"]);
  });

  it("returns empty structures for no input", () => {
    const { groups, undated } = groupByDay([], "due");
    expect(groups).toEqual([]);
    expect(undated).toEqual([]);
  });
});

describe("dayLabel", () => {
  const now = new Date(2026, 2, 4); // 4 Mar 2026, local

  it("uses relative words where they help", () => {
    expect(dayLabel(new Date(2026, 2, 4), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 2, 5), now)).toBe("Tomorrow");
    expect(dayLabel(new Date(2026, 2, 3), now)).toBe("Yesterday");
  });

  it("falls back to a real date further out", () => {
    const label = dayLabel(new Date(2026, 2, 20), now);
    expect(label).not.toMatch(/Today|Tomorrow|Yesterday/);
    expect(label).toContain("20");
  });

  it("includes the year only when it differs", () => {
    expect(dayLabel(new Date(2027, 0, 5), now)).toContain("2027");
    expect(dayLabel(new Date(2026, 5, 5), now)).not.toContain("2026");
  });
});

describe("isToday / dayKey", () => {
  it("pads to a stable YYYY-MM-DD key", () => {
    expect(dayKey(new Date(2026, 0, 9))).toBe("2026-01-09");
  });

  it("identifies today regardless of time of day", () => {
    const now = new Date(2026, 2, 4, 23, 59);
    expect(isToday(new Date(2026, 2, 4, 0, 1), now)).toBe(true);
    expect(isToday(new Date(2026, 2, 5, 0, 1), now)).toBe(false);
  });
});
