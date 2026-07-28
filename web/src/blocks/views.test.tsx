import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgendaView } from "./AgendaView";
import { GalleryView } from "./GalleryView";
import { auditA11y } from "@/lib/a11y-audit";

const records = [
  { id: "1", title: "Alpha", due: "2026-03-04T09:00:00" },
  { id: "2", title: "Beta", due: "2026-03-04T18:00:00" },
  { id: "3", title: "Gamma", due: "2026-03-06T09:00:00" },
  { id: "4", title: "Undated", due: "" },
];

const gallery = () =>
  renderToStaticMarkup(
    <GalleryView
      items={records}
      getItemId={(r) => r.id}
      onSelect={() => {}}
      renderCard={(r) => <span>{r.title}</span>}
      label="Reading"
    />,
  );

const agenda = () =>
  renderToStaticMarkup(
    <AgendaView
      items={records}
      dateField="due"
      getItemId={(r) => r.id}
      onSelect={() => {}}
      renderItem={(r) => <span>{r.title}</span>}
      label="Schedule"
    />,
  );

describe("GalleryView", () => {
  it("renders a labelled list of selectable cards", () => {
    const html = gallery();
    expect(html).toContain('aria-label="Reading"');
    expect(html).toContain("Alpha");
    // Cards are real buttons so keyboard and voice reach them.
    expect((html.match(/<button/g) ?? []).length).toBe(records.length);
  });

  it("passes the accessibility gate", () => {
    expect(auditA11y(gallery())).toEqual([]);
  });
});

describe("AgendaView", () => {
  it("groups by day under real headings", () => {
    const html = agenda();
    // Real <h3> headings make rotor/heading navigation work.
    expect((html.match(/<h3/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('aria-labelledby="agenda-2026-03-04"');
  });

  it("surfaces undated records rather than dropping them", () => {
    const html = agenda();
    expect(html).toContain("No date");
    expect(html).toContain("Undated");
  });

  it("passes the accessibility gate", () => {
    expect(auditA11y(agenda())).toEqual([]);
  });
});

describe("the renderer produces genuinely different surfaces", () => {
  it("gallery and agenda differ structurally, not just cosmetically", () => {
    const g = gallery();
    const a = agenda();
    // Agenda has day headings and sections; gallery has neither.
    expect(a).toMatch(/<h3/);
    expect(g).not.toMatch(/<h3/);
    expect(a).toMatch(/<section/);
    expect(g).not.toMatch(/<section/);
    // Gallery is a single flat list; agenda is several lists (one per day).
    expect((g.match(/<ul/g) ?? []).length).toBe(1);
    expect((a.match(/<ul/g) ?? []).length).toBeGreaterThan(1);
  });
});
