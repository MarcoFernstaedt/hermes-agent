/**
 * Capability wiring helpers.
 *
 * Capabilities are authored ONCE as JSON in
 * hermes_cli/capabilities/definitions and served over GET /api/capabilities.
 * The dashboard fetches them at boot (see useCapabilities) and derives its
 * routes, nav entries, boards, tables and forms from the same shape the
 * agent-tool generator reads — no page code is hand-written per area.
 *
 * This module owns the wire → UI mapping: the JSON's `icon` name string is
 * resolved to a lucide component here (the one thing that can't live in JSON).
 */
import {
  BookMarked,
  BriefcaseBusiness,
  CalendarDays,
  CheckSquare,
  Contact,
  FileText,
  Flag,
  ListTodo,
  Mail,
  NotebookText,
  Package,
  Star,
  Target,
  type LucideIcon,
} from "lucide-react";

import type { CapabilityDef, CapabilityFieldDef } from "@/lib/api";
import type { FieldDef, FieldType } from "@/blocks";
import type { ModuleGroup } from "@/modules/types";
import type { Capability, CapabilityView } from "./types";

/**
 * Icon-name → component map. The JSON declares an icon by kebab-case name so it
 * stays language-neutral; unknown names fall back to a neutral package glyph.
 */
const ICONS: Record<string, LucideIcon> = {
  "book-marked": BookMarked,
  "briefcase-business": BriefcaseBusiness,
  "calendar-days": CalendarDays,
  "check-square": CheckSquare,
  contact: Contact,
  "file-text": FileText,
  flag: Flag,
  "list-todo": ListTodo,
  mail: Mail,
  "notebook-text": NotebookText,
  star: Star,
  target: Target,
};

function iconFor(name: string | undefined): LucideIcon {
  return (name && ICONS[name]) || Package;
}

const FIELD_TYPES = new Set<FieldType>([
  "text",
  "number",
  "currency",
  "boolean",
  "date",
  "select",
  "tags",
  "markdown",
  "url",
]);

function fieldType(raw: string): FieldType {
  return FIELD_TYPES.has(raw as FieldType) ? (raw as FieldType) : "text";
}

function toField(f: CapabilityFieldDef): FieldDef {
  return {
    name: f.name,
    label: f.label ?? f.name,
    type: fieldType(f.type),
    required: f.required,
    options: f.options,
  };
}

/** Map a served capability declaration into the renderer's Capability shape. */
export function capabilityFromDef(def: CapabilityDef): Capability {
  return {
    id: def.id,
    label: def.label,
    icon: iconFor(def.icon),
    group: def.group as ModuleGroup | undefined,
    entity: def.entity ?? def.id,
    titleField: def.title_field,
    subtitleField: def.subtitle_field,
    fields: def.fields.map(toField),
    lifecycle: def.lifecycle,
    views: def.views as CapabilityView[],
  };
}

/** Route path a capability renders at. */
export function capabilityPath(cap: Capability): string {
  return `/c/${cap.id}`;
}
