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

describe("describeDeclaration", () => {
  it("summarises the surface in plain language", () => {
    const lines = describeDeclaration(draftToDeclaration(draftWithStatus()));
    expect(lines.join(" ")).toContain("Tasks");
    expect(lines.join(" ")).toContain("todo → doing → done");
  });
});
