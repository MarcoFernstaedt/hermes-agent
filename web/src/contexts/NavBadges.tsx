import { type ReactNode } from "react";

import { api } from "@/lib/api";
import { useData } from "@/lib/use-data";
import { NavBadgesContext, type NavBadgeMap } from "./nav-badges-context";

/**
 * Live counts surfaced as small badges on nav entries — unread email, events
 * today. Provided once near the app shell so both the sidebar and the mobile
 * drawer read the same values without each nav link fetching its own. The
 * underlying connection reads share cache keys with the Email/Calendar pages,
 * so opening those pages costs nothing extra.
 */

/** Local-day window [00:00, 24:00) as ISO strings, in the viewer's timezone. */
function todayWindowISO(): { timeMin: string; timeMax: string; key: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    key: `${start.getFullYear()}-${start.getMonth() + 1}-${start.getDate()}`,
  };
}

export function NavBadgesProvider({ children }: { children: ReactNode }) {
  // Email unread — poll every minute; only fetch the count once connected.
  const emailConn = useData("email:connection", api.getEmailConnection, {
    refreshInterval: 180000,
  });
  const emailReady = Boolean(
    emailConn.data?.connected && !emailConn.data?.needs_reauth,
  );
  const unread = useData(
    emailReady ? "email:unread_count" : null,
    api.getEmailUnreadCount,
    { refreshInterval: 60000 },
  );

  // Calendar — count today's events (viewer-local day).
  const calConn = useData("cal:connection", api.getCalendarConnection, {
    refreshInterval: 180000,
  });
  const calReady = Boolean(
    calConn.data?.connected && !calConn.data?.needs_reauth,
  );
  const { timeMin, timeMax, key } = todayWindowISO();
  const today = useData(
    calReady ? `cal:today:${key}` : null,
    () => api.listCalendarEvents(timeMin, timeMax),
    { refreshInterval: 180000 },
  );

  const badges: NavBadgeMap = {
    "/email": unread.data?.count ?? 0,
    "/calendar": today.data?.items?.length ?? 0,
  };

  return (
    <NavBadgesContext.Provider value={badges}>
      {children}
    </NavBadgesContext.Provider>
  );
}
