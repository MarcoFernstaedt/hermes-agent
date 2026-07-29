import { describe, expect, it } from "vitest";
import {
  declarationToDraft,
  describeDeclaration,
  draftToDeclaration,
  emptyDraft,
  slugify,
  type Draft,
} from "./builder-model";

function draftWithStatus(): Draft {
  return {
    id: "tasks",
    label: "Tasks",
    titleField: "title",
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      {
        name: "status", label: "Status", type: "select",
        options: [
          { value: "todo", label: "To do" },
          { value: "doing", label: "Doing" },
          { value: "done", label: "Done" },
        ],
      },
    ],
    lifecycleField: "status",
    tableColumns: ["title", "status"],
  };
}

describe("slugify", () => {
  it("produces a schema-valid id", () => {
    expect(slugify("My Reading List")).toBe("my-reading-list");
    expect(slugify("2024 Goals")).toBe("c2024-goals"); // must start with a letter
  });
});

describe("draftToDeclaration", () => {
  it("derives a lifecycle + board from the chosen select field", () => {
    const decl = draftToDeclaration(draftWithStatus());
    expect(decl.title_field).toBe("title");
    const lifecycle = decl.lifecycle as { field: string; states: string[]; initial: string };
    expect(lifecycle.field).toBe("status");
    expect(lifecycle.states).toEqual(["todo", "doing", "done"]);
    expect(lifecycle.initial).toBe("todo");
    const views = decl.views as Array<{ kind: string; default?: boolean }>;
    expect(views.some((v) => v.kind === "board" && v.default)).toBe(true);
    expect(views.some((v) => v.kind === "table")).toBe(true);
  });

  it("emits table-only (default) when no lifecycle field is chosen", () => {
    const d = emptyDraft();
    d.id = "notes";
    d.label = "Notes";
    d.titleField = "title";
    const decl = draftToDeclaration(d);
    expect(decl.lifecycle).toBeUndefined();
    const views = decl.views as Array<{ kind: string; default?: boolean }>;
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ kind: "table", default: true });
  });

  it("round-trips through declarationToDraft", () => {
    const decl = draftToDeclaration(draftWithStatus());
    const back = declarationToDraft(decl);
    expect(back.id).toBe("tasks");
    expect(back.lifecycleField).toBe("status");
    expect(back.tableColumns).toEqual(["title", "status"]);
    // And lowering the round-tripped draft yields the same declaration.
    expect(draftToDeclaration(back)).toEqual(decl);
  });
});

describe("gallery and agenda views", () => {
  it("emits a gallery view when asked", () => {
    const d = draftWithStatus();
    d.gallery = true;
    const views = draftToDeclaration(d).views as Array<{ kind: string }>;
    expect(views.some((v) => v.kind === "gallery")).toBe(true);
  });

  it("emits an agenda only for a real date field", () => {
    const d = draftWithStatus();
    d.agendaField = "status"; // a select, not a date — must not become an agenda
    expect((draftToDeclaration(d).views as Array<{ kind: string }>).some((v) => v.kind === "agenda"))
      .toBe(false);

    d.fields.push({ name: "due", label: "Due", type: "date" });
    d.agendaField = "due";
    const views = draftToDeclaration(d).views as Array<{ kind: string; dateField?: string }>;
    const agenda = views.find((v) => v.kind === "agenda");
    expect(agenda?.dateField).toBe("due");
  });

  it("round-trips the new view kinds", () => {
    const d = draftWithStatus();
    d.gallery = true;
    d.fields.push({ name: "due", label: "Due", type: "date" });
    d.agendaField = "due";
    const decl = draftToDeclaration(d);
    const back = declarationToDraft(decl);
    expect(back.gallery).toBe(true);
    expect(back.agendaField).toBe("due");
    expect(draftToDeclaration(back)).toEqual(decl);
  });
});

describe("templates", () => {
  it("every template lowers to a declaration the schema shape expects", async () => {
    const { TEMPLATES } = await import("./templates");
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(7);
    for (const t of TEMPLATES) {
      const decl = draftToDeclaration(t.draft) as Record<string, unknown>;
      // Same invariants the server validator enforces.
      expect(typeof decl.id).toBe("string");
      expect(decl.id).toMatch(/^[a-z][a-z0-9_-]*$/);
      const fields = decl.fields as Array<{ name: string }>;
      expect(fields.length).toBeGreaterThan(0);
      expect(fields.some((f) => f.name === decl.title_field)).toBe(true);
      const views = decl.views as Array<{ kind: string; default?: boolean }>;
      expect(views.length).toBeGreaterThan(0);
      expect(views.filter((v) => v.default).length).toBeLessThanOrEqual(1);
    }
  });

  it("gives distinct template ids", async () => {
    const { TEMPLATES } = await import("./templates");
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
  });
});

describe("describeDeclaration", () => {
  it("summarises the surface in plain language", () => {
    const lines = describeDeclaration(draftToDeclaration(draftWithStatus()));
    expect(lines.join(" ")).toContain("Tasks");
    expect(lines.join(" ")).toContain("todo → doing → done");
  });
});

describe("agent exposure", () => {
  it("emits agent.expose so a builder capability is not silently UI-only", () => {
    // Round-2 recon: a builder-authored declaration produced zero agent tools
    // because this section was never written. The default must be non-empty.
    const draft = { ...emptyDraft(), id: "notes", label: "Notes", titleField: "title" };
    const decl = draftToDeclaration(draft) as { agent?: { expose: string[] } };
    expect(decl.agent?.expose).toContain("list");
    expect(decl.agent?.expose).toContain("get");
    expect(decl.agent?.expose).toContain("create");
  });

  it("never exposes 'advance' without a lifecycle to advance through", () => {
    const draft = { ...emptyDraft(), id: "notes", label: "Notes", titleField: "title" };
    const decl = draftToDeclaration(draft) as { agent?: { expose: string[] } };
    expect(decl.agent?.expose).not.toContain("advance");
  });

  it("exposes 'advance' once a lifecycle field exists", () => {
    const draft = {
      ...emptyDraft(),
      id: "pipeline",
      label: "Pipeline",
      titleField: "title",
      fields: [
        { name: "title", label: "Title", type: "text" as const, required: true },
        {
          name: "stage",
          label: "Stage",
          type: "select" as const,
          options: [{ value: "todo", label: "Todo" }, { value: "done", label: "Done" }],
        },
      ],
      lifecycleField: "stage",
    };
    const decl = draftToDeclaration(draft) as { agent?: { expose: string[] } };
    expect(decl.agent?.expose).toContain("advance");
  });

  it("omits the agent section entirely when the owner unticks everything", () => {
    const draft = { ...emptyDraft(), id: "private", label: "Private", titleField: "title", expose: [] };
    const decl = draftToDeclaration(draft) as { agent?: unknown };
    expect(decl.agent).toBeUndefined();
  });

  it("says plainly when a capability has no agent tools", () => {
    const draft = { ...emptyDraft(), id: "private", label: "Private", titleField: "title", expose: [] };
    const lines = describeDeclaration(draftToDeclaration(draft));
    expect(lines.join(" ")).toMatch(/agent cannot see it/i);
  });

  it("round-trips exposure through declarationToDraft", () => {
    const draft = { ...emptyDraft(), id: "notes", label: "Notes", titleField: "title" };
    const back = declarationToDraft(draftToDeclaration(draft));
    expect(back.expose).toEqual(["list", "get", "create"]);
  });
});

describe("templates", () => {
  it("every template produces agent tools", async () => {
    const { TEMPLATES } = await import("./templates");
    for (const t of TEMPLATES) {
      const decl = draftToDeclaration(t.draft) as { agent?: { expose: string[] } };
      expect(decl.agent?.expose?.length, `${t.id} exposes nothing to the agent`).toBeGreaterThan(0);
    }
  });
});
