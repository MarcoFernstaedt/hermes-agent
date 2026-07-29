/**
 * Fetch declared capabilities from the server and map them into the renderer's
 * Capability shape. The declarations are authored once as JSON on the server
 * (hermes_cli/capabilities/definitions) and consumed here to build routes, nav
 * entries and the CapabilityArea surfaces — so a new working area ships without
 * touching frontend code.
 */
import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import { capabilityFromDef } from "./registry";
import type { Capability } from "./types";

export interface UseCapabilitiesResult {
  capabilities: Capability[];
  loading: boolean;
}

export function useCapabilities(): UseCapabilitiesResult {
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .getCapabilities()
      .then((res) => {
        if (cancelled) return;
        setCapabilities((res.capabilities ?? []).map(capabilityFromDef));
      })
      .catch(() => {
        // A capability fetch failure must not blank the shell — the built-in
        // pages still render; capability areas just won't appear.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { capabilities, loading };
}
