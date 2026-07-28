import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { LifeToday } from "@/lib/life";
import { ProgressView } from "./ProgressPage";

const today: LifeToday = {
  day: "2026-07-22",
  income_gate: {
    open: false,
    message: "Income gate closed. Complete one direct income action before optional building.",
  },
  totals: { active: 2, completed: 1 },
  habits: [
    {
      id: 1,
      name: "Direct income action",
      category: "income",
      target: 1,
      unit: "check",
      active: true,
      value: 0,
      note: "",
      complete: false,
    },
    {
      id: 2,
      name: "Move body",
      category: "health",
      target: 1,
      unit: "check",
      active: true,
      value: 1,
      note: "Walked",
      complete: true,
    },
  ],
  reflection: null,
  timeline: [],
};

const handlers = {
  onRetry: vi.fn(),
  onIncrement: vi.fn(),
  onDecrement: vi.fn(),
  onAddHabit: vi.fn().mockResolvedValue(true),
  onUpdateHabit: vi.fn().mockResolvedValue(true),
  onSaveReflection: vi.fn(),
};

describe("ProgressView", () => {
  it("renders an accessible income gate and habit controls", () => {
    const html = renderToStaticMarkup(
      <ProgressView state="ready" today={today} history={[]} {...handlers} />,
    );

    expect(html).toContain('aria-labelledby="progress-heading"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Income gate closed");
    expect(html).toContain('aria-label="Add one to Direct income action"');
    expect(html).toContain('aria-label="Remove one from Move body"');
    expect(html).toContain("Today: 1 of 2 complete");
    expect(html).toContain("Manage habit");
    expect(html).toContain("Deactivate habit");
    expect(html).toContain("Daily reflection");
  });

  it("renders loading and failure states without implying empty progress", () => {
    const loading = renderToStaticMarkup(
      <ProgressView state="loading" today={null} history={[]} {...handlers} />,
    );
    const error = renderToStaticMarkup(
      <ProgressView state="error" error="Progress could not load." today={null} history={[]} {...handlers} />,
    );

    expect(loading).toContain("Loading progress…");
    expect(error).toContain('role="alert"');
    expect(error).toContain("Progress could not load.");
  });

  it("shows mutation failures visually as well as in the live region", () => {
    const html = renderToStaticMarkup(
      <ProgressView
        state="ready"
        today={today}
        history={[]}
        operationError="Move body was not updated. Try again."
        {...handlers}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Move body was not updated. Try again.");
  });
});
