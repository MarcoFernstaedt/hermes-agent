/**
 * Where the durable session id lives between page loads.
 *
 * The whole point of splitting live and durable identity is that a refresh can
 * reattach instead of creating. That only works if the durable id outlives the
 * page — so it has to be persisted, and persisted correctly:
 *
 * **Per profile.** Two profiles are two conversations with two state databases;
 * resuming profile A's session under profile B would either fail or, worse,
 * succeed and show the wrong history.
 *
 * **`localStorage`, not `sessionStorage`.** A durable id that dies with the tab
 * defeats the purpose — reopening the dashboard should find the conversation
 * where it was left.
 *
 * **Written only after a session is confirmed.** Recording an id we have not
 * seen the gateway acknowledge would make the next load resume something that
 * may never have existed.
 */

const PREFIX = "imperator.nativeChat.session";

function keyFor(profile: string): string {
  return `${PREFIX}:${profile || "default"}`;
}

/** Read the durable id to resume, or null when there is nothing to resume. */
export function loadDurableSessionId(profile = "default"): string | null {
  try {
    const value = window.localStorage.getItem(keyFor(profile));
    return value && value.trim() ? value : null;
  } catch {
    // Private browsing or storage disabled: no persistence, but chat still
    // works — it simply creates a fresh session each load.
    return null;
  }
}

/** Persist a confirmed durable id. Passing null clears it. */
export function saveDurableSessionId(id: string | null, profile = "default"): void {
  try {
    if (id && id.trim()) window.localStorage.setItem(keyFor(profile), id);
    else window.localStorage.removeItem(keyFor(profile));
  } catch {
    /* storage unavailable — degrade to no persistence rather than failing */
  }
}

export function clearDurableSessionId(profile = "default"): void {
  saveDurableSessionId(null, profile);
}
