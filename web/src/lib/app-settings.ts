import { useSyncExternalStore } from "react";
import { api } from "@/lib/api";

/**
 * App-level user preferences.
 *
 * The SERVER is the source of truth (persisted in config.yaml under
 * `dashboard.prefs`, so settings survive a reload, a new browser and a
 * different device). localStorage is only an optimistic cache: it seeds the
 * first paint instantly, then is reconciled against the server on load.
 * Writes are optimistic + debounced — the local value applies immediately
 * and a merged PUT flushes shortly after, with a quiet saved indicator.
 *
 * Every preference here is MACHINE-WIDE except `lastActiveSession`, which is
 * a per-profile map (keyed by management profile).
 */

export type Density = "comfortable" | "compact";
export type MotionPref = "full" | "reduced";

export interface AppSettings {
  /** Browser notifications for Imperator replies (never tool calls). */
  notificationsEnabled: boolean;
  /** Render tool/system activity rows in the chat feed. */
  showToolCalls: boolean;
  /** UI density. */
  density: Density;
  /** Honour reduced motion regardless of the OS setting. */
  motion: MotionPref;
  /** Play a sound cue when a reply completes. */
  sound: boolean;
  /** Show message timestamps in the chat feed. */
  showTimestamps: boolean;
  /** Show token/cost readouts where available. */
  showTokenCost: boolean;
  /** Collapsed state of the desktop sidebar. */
  sidebarCollapsed: boolean;
  /** Collapsed state of the chat model/tools rail. */
  railCollapsed: boolean;
  /** Preferred default model (empty = server/profile default). */
  defaultModel: string;
  /** Preferred default management profile (empty = none). */
  defaultProfile: string;
  /** Last active chat session id, keyed by management profile. */
  lastActiveSession: Record<string, string>;
  /** Pinned session ids (sort to the top of session lists). Cross-device. */
  pinnedSessions: string[];
}

const STORAGE_KEY = "imperator-app-settings";
const LEGACY_SIDEBAR_KEY = "hermes-sidebar-collapsed";

const DEFAULTS: AppSettings = {
  notificationsEnabled: false,
  showToolCalls: true,
  density: "comfortable",
  motion: "full",
  sound: false,
  showTimestamps: true,
  showTokenCost: true,
  sidebarCollapsed: false,
  railCollapsed: false,
  defaultModel: "",
  defaultProfile: "",
  lastActiveSession: {},
  pinnedSessions: [],
};

export type SaveStatus = "idle" | "saving" | "saved";

let cached: AppSettings = loadLocal();
let saveStatus: SaveStatus = "idle";
let hydrated = false;
const listeners = new Set<() => void>();
const statusListeners = new Set<() => void>();

function loadLocal(): AppSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<AppSettings>) : {};
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeLocal(value: AppSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* private browsing — in-memory value still applies this session */
  }
}

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function setStatus(next: SaveStatus): void {
  saveStatus = next;
  for (const listener of [...statusListeners]) listener();
}

export function getAppSettings(): AppSettings {
  return cached;
}

export function getSaveStatus(): SaveStatus {
  return saveStatus;
}

/** Merge only keys we recognise, coercing to the declared shapes. */
function coerce(raw: Record<string, unknown>): Partial<AppSettings> {
  const out: Partial<AppSettings> = {};
  const b = (v: unknown) => v === true;
  if ("notificationsEnabled" in raw) out.notificationsEnabled = b(raw.notificationsEnabled);
  if ("showToolCalls" in raw) out.showToolCalls = b(raw.showToolCalls);
  if (raw.density === "compact" || raw.density === "comfortable") out.density = raw.density;
  if (raw.motion === "reduced" || raw.motion === "full") out.motion = raw.motion;
  if ("sound" in raw) out.sound = b(raw.sound);
  if ("showTimestamps" in raw) out.showTimestamps = b(raw.showTimestamps);
  if ("showTokenCost" in raw) out.showTokenCost = b(raw.showTokenCost);
  if ("sidebarCollapsed" in raw) out.sidebarCollapsed = b(raw.sidebarCollapsed);
  if ("railCollapsed" in raw) out.railCollapsed = b(raw.railCollapsed);
  if (typeof raw.defaultModel === "string") out.defaultModel = raw.defaultModel;
  if (typeof raw.defaultProfile === "string") out.defaultProfile = raw.defaultProfile;
  if (raw.lastActiveSession && typeof raw.lastActiveSession === "object") {
    out.lastActiveSession = Object.fromEntries(
      Object.entries(raw.lastActiveSession as Record<string, unknown>)
        .filter(([, v]) => typeof v === "string")
        .map(([k, v]) => [k, String(v)]),
    );
  }
  if (Array.isArray(raw.pinnedSessions)) {
    out.pinnedSessions = raw.pinnedSessions.filter((v): v is string => typeof v === "string");
  }
  return out;
}

/**
 * Reconcile against the server exactly once on app load. Server values win.
 * If the server has never stored prefs, migrate whatever's in the legacy
 * localStorage keys up to it, then stop reading the old locations.
 */
export async function hydrateAppSettings(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const { prefs } = await api.getDashboardPrefs();
    if (prefs && Object.keys(prefs).length > 0) {
      cached = { ...cached, ...coerce(prefs) };
      writeLocal(cached);
      emit();
      return;
    }
    // First run against a server with no stored prefs — migrate local state.
    const migrated: AppSettings = { ...cached };
    try {
      const legacySidebar = window.localStorage.getItem(LEGACY_SIDEBAR_KEY);
      if (legacySidebar !== null) migrated.sidebarCollapsed = legacySidebar === "true";
    } catch {
      /* ignore */
    }
    cached = migrated;
    writeLocal(cached);
    emit();
    await api.setDashboardPrefs(cached as unknown as Record<string, unknown>);
    try {
      window.localStorage.removeItem(LEGACY_SIDEBAR_KEY);
    } catch {
      /* ignore */
    }
  } catch {
    // Offline / unauthenticated — keep the optimistic local cache.
  }
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  setStatus("saving");
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void api
      .setDashboardPrefs(cached as unknown as Record<string, unknown>)
      .then(() => {
        setStatus("saved");
        setTimeout(() => saveStatus === "saved" && setStatus("idle"), 1500);
      })
      .catch(() => setStatus("idle"));
  }, 400);
}

export function setAppSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K],
): void {
  cached = { ...cached, [key]: value };
  writeLocal(cached); // optimistic cache
  emit();
  scheduleFlush(); // debounced server write (source of truth)
}

/** Record the last active session for a profile (per-profile sub-map). */
export function setLastActiveSession(profile: string, sessionId: string): void {
  const key = profile || "__own__";
  if (cached.lastActiveSession[key] === sessionId) return;
  setAppSetting("lastActiveSession", { ...cached.lastActiveSession, [key]: sessionId });
}

export function getLastActiveSession(profile: string): string | undefined {
  return cached.lastActiveSession[profile || "__own__"];
}

/** Toggle whether a session is pinned (sorted to the top of session lists). */
export function togglePinnedSession(sessionId: string): void {
  const pinned = cached.pinnedSessions.includes(sessionId)
    ? cached.pinnedSessions.filter((id) => id !== sessionId)
    : [...cached.pinnedSessions, sessionId];
  setAppSetting("pinnedSessions", pinned);
}

export function subscribeAppSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function subscribeSaveStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/** React hook — re-renders when any app setting changes. */
export function useAppSettings(): AppSettings {
  return useSyncExternalStore(subscribeAppSettings, getAppSettings, getAppSettings);
}

/** React hook — the quiet saved indicator state. */
export function useSaveStatus(): SaveStatus {
  return useSyncExternalStore(subscribeSaveStatus, getSaveStatus, getSaveStatus);
}
