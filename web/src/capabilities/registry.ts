/**
 * Declared capabilities. Adding a working area is adding a declaration here —
 * the route, nav entry, board/table/form and agent-facing entity storage all
 * derive from it (see App.tsx capability wiring). No page code is written.
 */
import { BookMarked } from "lucide-react";

import type { Capability } from "./types";

/** A reading list — the first area that exists purely as a declaration. */
const readingList: Capability = {
  id: "reading",
  label: "Reading",
  icon: BookMarked,
  group: "read",
  titleField: "title",
  subtitleField: "author",
  fields: [
    { name: "title", label: "Title", type: "text", required: true },
    { name: "author", label: "Author", type: "text" },
    { name: "url", label: "Link", type: "url" },
    {
      name: "status",
      label: "Status",
      type: "select",
      options: [
        { value: "to_read", label: "To read" },
        { value: "reading", label: "Reading" },
        { value: "done", label: "Done" },
        { value: "abandoned", label: "Abandoned" },
      ],
    },
    { name: "tags", label: "Tags", type: "tags" },
    { name: "notes", label: "Notes", type: "markdown" },
  ],
  lifecycle: {
    field: "status",
    states: ["to_read", "reading", "done", "abandoned"],
    initial: "to_read",
    transitions: [
      { from: "to_read", to: ["reading", "abandoned"] },
      { from: "reading", to: ["done", "abandoned"] },
      { from: "*", to: ["to_read"] },
    ],
  },
  views: [
    { id: "board", kind: "board", default: true },
    { id: "table", kind: "table", columns: ["title", "author", "status", "tags"] },
  ],
};

export const CAPABILITIES: Capability[] = [readingList];

/** Route path a capability renders at. */
export function capabilityPath(cap: Capability): string {
  return `/c/${cap.id}`;
}
