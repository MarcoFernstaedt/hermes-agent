import { getAppSettings } from "./app-settings";

/**
 * Reply notifications + app-icon unread badge.
 *
 * Policy (deliberate): notify ONLY for completed Imperator replies —
 * never tool calls, never streaming deltas — and only while the tab is
 * hidden (in view, the feed itself is the notification). The unread
 * count feeds the OS app-icon badge (Badging API) for the installed
 * app; it clears the moment the chat is visible again.
 */

let unreadCount = 0;

function syncAppBadge(): void {
  const nav = navigator as Navigator & {
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (unreadCount > 0) void nav.setAppBadge?.(unreadCount);
    else void nav.clearAppBadge?.();
  } catch {
    // Badging unsupported — the in-page indicators still cover it.
  }
}

/** Compress a reply into a one-glance notification body. */
export function notificationBody(text: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  if (!flattened) return "Imperator finished a reply.";
  return flattened.length > 140 ? `${flattened.slice(0, 139)}…` : flattened;
}

export function notifyAssistantReply(text: string): void {
  if (!getAppSettings().notificationsEnabled) return;
  if (typeof document === "undefined" || !document.hidden) return;

  unreadCount += 1;
  syncAppBadge();

  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  try {
    const notification = new Notification("Imperator replied", {
      body: notificationBody(text),
      icon: "/icons/imperator-192.png",
      badge: "/icons/imperator-192.png",
      tag: "imperator-reply",
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Some engines require a service-worker notification path; the app
    // badge above still signals the unread reply.
  }
}

export function clearUnreadReplies(): void {
  if (unreadCount === 0) return;
  unreadCount = 0;
  syncAppBadge();
}

/** Ask for permission; returns whether notifications can be shown. */
export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}
