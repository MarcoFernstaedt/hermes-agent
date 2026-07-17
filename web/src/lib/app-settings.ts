import { useSyncExternalStore } from "react";

/**
 * App-level user preferences, persisted in localStorage and shared across
 * components via useSyncExternalStore. Each setting lives HERE and nowhere
 * else — a control that writes a setting binds to this store, so the same
 * preference is never duplicated across surfaces.
 */

export interface AppSettings {
  /** Browser notifications for Imperator replies (never tool calls). */
  notificationsEnabled: boolean;
  /** Render tool/system activity rows in the chat feed. */
  showToolCalls: boolean;
}

const STORAGE_KEY = "imperator-app-settings";

const DEFAULTS: AppSettings = {
  notificationsEnabled: false,
  showToolCalls: true,
};

let cached: AppSettings = load();
const listeners = new Set<() => void>();

function load(): AppSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getAppSettings(): AppSettings {
  return cached;
}

export function setAppSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K],
): void {
  cached = { ...cached, [key]: value };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    // Private browsing — the in-memory value still applies this session.
  }
  for (const listener of [...listeners]) listener();
}

export function subscribeAppSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook — re-renders when any app setting changes. */
export function useAppSettings(): AppSettings {
  return useSyncExternalStore(
    subscribeAppSettings,
    getAppSettings,
    getAppSettings,
  );
}
