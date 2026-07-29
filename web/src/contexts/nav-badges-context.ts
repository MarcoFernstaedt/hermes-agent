import { createContext, useContext } from "react";

/** Live counts surfaced as badges on nav entries, keyed by nav path. */
export type NavBadgeMap = Record<string, number>;

export const NavBadgesContext = createContext<NavBadgeMap>({});

/** The badge count for a nav path (0 when none / not provided). */
export function useNavBadge(path: string): number {
  return useContext(NavBadgesContext)[path] ?? 0;
}
