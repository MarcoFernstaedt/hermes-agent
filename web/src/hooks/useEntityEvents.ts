import { useEffect, useRef } from "react";

import {
  subscribeEntityEvents,
  type EntityEvent,
} from "@/lib/entity-events";

/**
 * Fire `onChange` whenever a live entity change arrives for `type` (or for any
 * type when `type` is "*"). Consumers typically call their data refetch inside
 * onChange so a generated list/board updates the moment a record changes —
 * including changes the agent makes. The handler is kept in a ref so
 * subscribing doesn't churn.
 */
export function useEntityEvents(
  type: string,
  onChange: (event: EntityEvent) => void,
): void {
  const handlerRef = useRef(onChange);
  useEffect(() => {
    handlerRef.current = onChange;
  });

  useEffect(() => {
    return subscribeEntityEvents((event) => {
      if (type === "*" || event.type === type) handlerRef.current(event);
    });
  }, [type]);
}
