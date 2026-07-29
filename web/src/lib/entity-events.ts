/**
 * Live entity-change stream. The backend broadcasts a small frame on the
 * "entities" channel whenever a record is created/updated/deleted; this module
 * parses those frames and lets lists/boards/tables refresh in place instead of
 * polling. The frame parser is pure and unit-tested; subscription rides the
 * shared dashboard-events socket hub.
 */
import { subscribeDashboardEvents } from "./event-channel-hub";

export type EntityAction = "created" | "updated" | "deleted";

export interface EntityEvent {
  type: string;
  id: string;
  action: EntityAction;
  version: number;
}

const ACTIONS = new Set<EntityAction>(["created", "updated", "deleted"]);

/** Parse an "entities" channel frame; returns null for anything unrecognised. */
export function parseEntityEvent(data: unknown): EntityEvent | null {
  let obj: unknown = data;
  if (typeof data === "string") {
    try {
      obj = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.kind !== "entity") return null;
  if (typeof o.type !== "string" || typeof o.id !== "string") return null;
  if (typeof o.action !== "string" || !ACTIONS.has(o.action as EntityAction)) return null;
  return {
    type: o.type,
    id: o.id,
    action: o.action as EntityAction,
    version: typeof o.version === "number" ? o.version : 0,
  };
}

/**
 * Subscribe to all entity changes. `handler` fires per parsed event; returns an
 * unsubscribe function. Filtering by type is the caller's job (see
 * useEntityEvents).
 */
export function subscribeEntityEvents(
  handler: (event: EntityEvent) => void,
): () => void {
  return subscribeDashboardEvents("entities", {
    onMessage: (event: MessageEvent) => {
      const parsed = parseEntityEvent(event.data);
      if (parsed) handler(parsed);
    },
  });
}
