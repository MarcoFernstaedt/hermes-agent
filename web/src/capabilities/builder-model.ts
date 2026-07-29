/**
 * Pure model for the visual capability builder. A *draft* is the editable shape
 * the form manipulates; `draftToDeclaration` lowers it to the exact declaration
 * document the agent path also produces, so both authoring paths converge on one
 * artifact validated by the same server schema. No React, no network — unit-testable.
 */
import type { FieldType } from "@/blocks/fields";

export const FIELD_TYPES: FieldType[] = [
  "text", "number", "currency", "boolean", "date", "select", "tags", "markdown", "url",
];

export interface DraftOption {
  value: string;
  label: string;
}

export interface DraftField {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: DraftOption[];
}

export interface Draft {
  id: string;
  label: string;
  icon?: string;
  titleField: string;
  subtitleField?: string;
  fields: DraftField[];
  /** When set (a select field's name), a board view + lifecycle are derived. */
  lifecycleField?: string;
  /** Field names shown as table columns; empty = all fields. */
  tableColumns: string[];
  /** Extra view kinds beyond the always-present table. */
  gallery?: boolean;
  /** Field to group an agenda by; set ⇒ an agenda view is emitted. */
  agendaField?: string;
  /**
   * Which operations the agent may perform on this area. Round-2 recon found
   * builder-authored capabilities generated *zero* agent tools, because this
   * was never emitted — you got a working UI the agent could not see. It is now
   * explicit and defaulted, never silently absent. `delete` is not offered:
   * the schema forbids exposing destructive ops at all.
   */
  expose: AgentOp[];
}

/** The operations a capability may expose to the agent. Mirrors AGENT_OPS server-side. */
export type AgentOp = "list" | "get" | "create" | "advance";

export const AGENT_OPS: AgentOp[] = ["list", "get", "create", "advance"];

export const AGENT_OP_LABELS: Record<AgentOp, string> = {
  list: "List and search records",
  get: "Read a single record",
  create: "Add new records",
  advance: "Move records through the board",
};

export function emptyDraft(): Draft {
  return {
    id: "",
    label: "",
    titleField: "",
    fields: [{ name: "title", label: "Title", type: "text", required: true }],
    tableColumns: [],
    // Read plus create by default: useful to the agent immediately, and no
    // destructive op is offered anywhere in this builder.
    expose: ["list", "get", "create", "advance"],
  };
}

export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^([0-9])/, "c$1");
}

/** Lower a draft to a declaration document (the wire shape the schema validates). */
export function draftToDeclaration(draft: Draft): Record<string, unknown> {
  const fields = draft.fields.map((f) => {
    const out: Record<string, unknown> = { name: f.name, label: f.label, type: f.type };
    if (f.required) out.required = true;
    if (f.type === "select" && f.options?.length) out.options = f.options;
    return out;
  });

  const decl: Record<string, unknown> = {
    id: draft.id,
    label: draft.label,
    title_field: draft.titleField,
    fields,
  };
  if (draft.icon) decl.icon = draft.icon;
  if (draft.subtitleField) decl.subtitle_field = draft.subtitleField;

  const views: Record<string, unknown>[] = [];
  const lifecycleField = draft.fields.find(
    (f) => f.name === draft.lifecycleField && f.type === "select" && f.options?.length,
  );
  if (lifecycleField && lifecycleField.options) {
    const states = lifecycleField.options.map((o) => o.value);
    decl.lifecycle = {
      field: lifecycleField.name,
      states,
      initial: states[0],
      transitions: [
        // A simple linear pipeline, plus a reset to the first state from anywhere.
        ...states.slice(0, -1).map((s, i) => ({ from: s, to: [states[i + 1]] })),
        { from: "*", to: [states[0]] },
      ],
    };
    views.push({ id: "board", kind: "board", default: true });
  }
  if (draft.gallery) {
    // Never the default. Recon: the owner's records are state- and
    // action-oriented, so a gallery of them is decorative — board or table
    // does the work. Gallery earns its place on image-rich data, chosen
    // deliberately, not by being the only view that claimed the slot.
    views.push({ id: "gallery", kind: "gallery" });
  }
  const agendaField = draft.fields.find(
    (f) => f.name === draft.agendaField && f.type === "date",
  );
  if (agendaField) {
    views.push({
      id: "agenda",
      kind: "agenda",
      dateField: agendaField.name,
      ...(views.length === 0 ? { default: true } : {}),
    });
  }
  const tableView: Record<string, unknown> = { id: "table", kind: "table" };
  if (draft.tableColumns.length) tableView.columns = draft.tableColumns;
  // The table is the fallback default: it claims the slot whenever nothing
  // *else* has. Testing `views.length === 0` was equivalent only while every
  // other view claimed default on sight — once gallery stopped doing so, a
  // gallery-plus-table capability had no default view at all.
  if (!views.some((v) => v.default)) tableView.default = true;
  views.push(tableView);
  decl.views = views;

  // `advance` only generates a tool when a lifecycle exists, so don't claim it
  // otherwise — an exposed op that produces nothing is the same silent lie as
  // omitting the section entirely.
  const expose = (draft.expose ?? []).filter((op) => op !== "advance" || Boolean(decl.lifecycle));
  if (expose.length) decl.agent = { expose };

  return decl;
}

/** Lift an existing declaration back into a draft (for clone-as-start). */
export function declarationToDraft(decl: Record<string, unknown>): Draft {
  const fields = ((decl.fields as DraftField[]) ?? []).map((f) => ({
    name: f.name, label: f.label, type: f.type, required: f.required, options: f.options,
  }));
  const lifecycle = decl.lifecycle as { field?: string } | undefined;
  const declViews = (decl.views as Array<{ kind: string; columns?: string[]; dateField?: string }>) ?? [];
  const tableView = declViews.find((v) => v.kind === "table");
  const agendaView = declViews.find((v) => v.kind === "agenda");
  return {
    id: typeof decl.id === "string" ? decl.id : "",
    label: typeof decl.label === "string" ? decl.label : "",
    icon: typeof decl.icon === "string" ? decl.icon : undefined,
    titleField: typeof decl.title_field === "string" ? decl.title_field : "",
    subtitleField: typeof decl.subtitle_field === "string" ? decl.subtitle_field : undefined,
    fields,
    lifecycleField: lifecycle?.field,
    tableColumns: tableView?.columns ?? [],
    gallery: declViews.some((v) => v.kind === "gallery"),
    agendaField: agendaView?.dateField,
    expose: (((decl.agent as { expose?: string[] } | undefined)?.expose ?? []).filter(
      (op): op is AgentOp => (AGENT_OPS as string[]).includes(op),
    )),
  };
}

/** A human, screen-reader-friendly summary of what a declaration will create. */
export function describeDeclaration(decl: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const fields = (decl.fields as DraftField[]) ?? [];
  lines.push(`A "${decl.label}" area storing records with ${fields.length} field${fields.length === 1 ? "" : "s"}.`);
  const lifecycle = decl.lifecycle as { states?: string[] } | undefined;
  if (lifecycle?.states?.length) {
    lines.push(`A board that moves records through: ${lifecycle.states.join(" → ")}.`);
  }
  const views = (decl.views as Array<{ kind: string }>) ?? [];
  const kinds = [...new Set(views.map((v) => v.kind))];
  lines.push(`Views: ${kinds.join(", ")}.`);
  const expose = ((decl.agent as { expose?: AgentOp[] } | undefined)?.expose ?? []);
  lines.push(
    expose.length
      ? `Agent tools: ${expose.map((op) => AGENT_OP_LABELS[op] ?? op).join(", ").toLowerCase()}.`
      : "No agent tools — this area is yours to use in the app, and the agent cannot see it.",
  );
  return lines;
}
