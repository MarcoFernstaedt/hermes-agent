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
}

export function emptyDraft(): Draft {
  return {
    id: "",
    label: "",
    titleField: "",
    fields: [{ name: "title", label: "Title", type: "text", required: true }],
    tableColumns: [],
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
  const tableView: Record<string, unknown> = { id: "table", kind: "table" };
  if (draft.tableColumns.length) tableView.columns = draft.tableColumns;
  if (views.length === 0) tableView.default = true;
  views.push(tableView);
  decl.views = views;

  return decl;
}

/** Lift an existing declaration back into a draft (for clone-as-start). */
export function declarationToDraft(decl: Record<string, unknown>): Draft {
  const fields = ((decl.fields as DraftField[]) ?? []).map((f) => ({
    name: f.name, label: f.label, type: f.type, required: f.required, options: f.options,
  }));
  const lifecycle = decl.lifecycle as { field?: string } | undefined;
  const tableView = ((decl.views as Array<{ kind: string; columns?: string[] }>) ?? []).find(
    (v) => v.kind === "table",
  );
  return {
    id: typeof decl.id === "string" ? decl.id : "",
    label: typeof decl.label === "string" ? decl.label : "",
    icon: typeof decl.icon === "string" ? decl.icon : undefined,
    titleField: typeof decl.title_field === "string" ? decl.title_field : "",
    subtitleField: typeof decl.subtitle_field === "string" ? decl.subtitle_field : undefined,
    fields,
    lifecycleField: lifecycle?.field,
    tableColumns: tableView?.columns ?? [],
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
  return lines;
}
