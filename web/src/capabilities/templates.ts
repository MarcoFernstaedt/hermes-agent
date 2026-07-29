/**
 * Capability templates — a new tracker is never blank.
 *
 * Each template is a `Draft`, so it flows through exactly the same lowering,
 * validation, dry-run and approval as anything hand-built or agent-authored.
 * A template is a starting point, not a special case: pick one, edit it, propose
 * it. They are deliberately small — a template that guesses fifteen fields is a
 * form to delete, not a head start.
 */
import type { Draft } from "./builder-model";

export interface CapabilityTemplate {
  id: string;
  name: string;
  description: string;
  draft: Draft;
}

const select = (name: string, label: string, options: [string, string][]) => ({
  name,
  label,
  type: "select" as const,
  options: options.map(([value, l]) => ({ value, label: l })),
});

export const TEMPLATES: CapabilityTemplate[] = [
  {
    id: "crm",
    name: "Contacts / CRM",
    description: "People and companies, moving through a relationship pipeline.",
    draft: {
      id: "crm",
      label: "CRM",
      titleField: "name",
      subtitleField: "company",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "company", label: "Company", type: "text" },
        { name: "email", label: "Email", type: "text" },
        select("stage", "Stage", [
          ["lead", "Lead"],
          ["contacted", "Contacted"],
          ["meeting", "Meeting"],
          ["won", "Won"],
        ]),
        { name: "notes", label: "Notes", type: "markdown" },
      ],
      lifecycleField: "stage",
      tableColumns: ["name", "company", "stage"],
      expose: ["list", "get", "create", "advance"],
    },
  },
  {
    id: "reading",
    name: "Reading list",
    description: "Things to read, as a gallery of objects rather than rows.",
    draft: {
      id: "reading-list",
      label: "Reading list",
      titleField: "title",
      subtitleField: "author",
      fields: [
        { name: "title", label: "Title", type: "text", required: true },
        { name: "author", label: "Author", type: "text" },
        { name: "url", label: "Link", type: "url" },
        select("status", "Status", [
          ["queued", "Queued"],
          ["reading", "Reading"],
          ["done", "Done"],
        ]),
        { name: "tags", label: "Tags", type: "tags" },
      ],
      lifecycleField: "status",
      gallery: true,
      tableColumns: ["title", "author", "status"],
      expose: ["list", "get", "create", "advance"],
    },
  },
  {
    id: "ledger",
    name: "Finance ledger",
    description: "Money in and out, as a table with amounts.",
    draft: {
      id: "ledger",
      label: "Ledger",
      titleField: "description",
      fields: [
        { name: "description", label: "Description", type: "text", required: true },
        { name: "amount", label: "Amount", type: "currency", required: true },
        { name: "date", label: "Date", type: "date" },
        select("direction", "Direction", [
          ["in", "In"],
          ["out", "Out"],
        ]),
      ],
      agendaField: "date",
      tableColumns: ["date", "description", "amount", "direction"],
      expose: ["list", "get", "create", "advance"],
    },
  },
  {
    id: "habits",
    name: "Habit log",
    description: "A daily log you can see as an agenda.",
    draft: {
      id: "habit-log",
      label: "Habit log",
      titleField: "habit",
      fields: [
        { name: "habit", label: "Habit", type: "text", required: true },
        { name: "day", label: "Day", type: "date", required: true },
        { name: "done", label: "Done", type: "boolean" },
        { name: "note", label: "Note", type: "text" },
      ],
      agendaField: "day",
      tableColumns: ["day", "habit", "done"],
      expose: ["list", "get", "create", "advance"],
    },
  },
  {
    id: "projects",
    name: "Project tracker",
    description: "Work moving through stages, as a board.",
    draft: {
      id: "projects",
      label: "Projects",
      titleField: "name",
      subtitleField: "owner",
      fields: [
        { name: "name", label: "Project", type: "text", required: true },
        { name: "owner", label: "Owner", type: "text" },
        { name: "due", label: "Due", type: "date" },
        select("status", "Status", [
          ["planned", "Planned"],
          ["active", "Active"],
          ["blocked", "Blocked"],
          ["shipped", "Shipped"],
        ]),
      ],
      lifecycleField: "status",
      tableColumns: ["name", "owner", "due", "status"],
      expose: ["list", "get", "create", "advance"],
    },
  },
  {
    id: "content",
    name: "Content pipeline",
    description: "Drafts moving to published, with a gallery of pieces.",
    draft: {
      id: "content",
      label: "Content",
      titleField: "title",
      subtitleField: "channel",
      fields: [
        { name: "title", label: "Title", type: "text", required: true },
        { name: "channel", label: "Channel", type: "text" },
        { name: "publish", label: "Publish", type: "date" },
        select("stage", "Stage", [
          ["idea", "Idea"],
          ["draft", "Draft"],
          ["review", "Review"],
          ["published", "Published"],
        ]),
      ],
      lifecycleField: "stage",
      gallery: true,
      agendaField: "publish",
      tableColumns: ["title", "channel", "publish", "stage"],
      expose: ["list", "get", "create", "advance"],
    },
  },
  {
    id: "learning",
    name: "Learning tracker",
    description: "What you are studying and how far in you are.",
    draft: {
      id: "learning",
      label: "Learning",
      titleField: "topic",
      fields: [
        { name: "topic", label: "Topic", type: "text", required: true },
        { name: "source", label: "Source", type: "url" },
        { name: "progress", label: "Progress %", type: "number" },
        select("status", "Status", [
          ["queued", "Queued"],
          ["learning", "Learning"],
          ["known", "Known"],
        ]),
      ],
      lifecycleField: "status",
      tableColumns: ["topic", "progress", "status"],
      expose: ["list", "get", "create", "advance"],
    },
  },
];

export function templateById(id: string): CapabilityTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
