/**
 * Per-session composer drafts, persisted in localStorage so an unsent
 * message survives a reload, navigation away and back, or a rotation. Drafts
 * are intentionally device-local and ephemeral (unlike synced settings), so
 * localStorage is the right store — instant, no round-trip per keystroke.
 *
 * Keyed by `<profile>\0<session>` so each conversation keeps its own draft.
 */
const PREFIX = "imperator-chat-draft:";

export function getDraft(key: string): string {
  try {
    return window.localStorage.getItem(PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

export function setDraft(key: string, text: string): void {
  try {
    if (text) window.localStorage.setItem(PREFIX + key, text);
    else window.localStorage.removeItem(PREFIX + key);
  } catch {
    /* private browsing — the in-memory composer value still applies */
  }
}

export function clearDraft(key: string): void {
  setDraft(key, "");
}
