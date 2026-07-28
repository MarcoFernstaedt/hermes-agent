function hash32(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * A keep-alive PTY's sidecar publisher is fixed to the channel supplied when
 * that process starts. Derive the subscriber channel from the same persistent
 * attach identity so a browser reload reattaches to both halves together.
 */
export function eventChannelForPtyAttach(attachToken: string): string {
  return `chat-${hash32(attachToken, 0x811c9dc5)}-${hash32(
    attachToken,
    0x9e3779b9,
  )}`;
}

/** Use an opaque channel-derived name so the raw attach token is not exposed. */
export function ptyOwnershipLockName(attachToken: string): string {
  return `hermes.pty.owner.${eventChannelForPtyAttach(attachToken)}`;
}

/**
 * A real reload may wait briefly for its outgoing document to release the
 * token lock. Other navigations must probe atomically and rotate if occupied.
 */
export function shouldWaitForExistingPtyLock(
  navigationType: string | undefined,
): boolean {
  return navigationType === "reload";
}

/** Attachment is gated only by ownership of the exact current token. */
export function isPtyOwnershipReady(
  attachToken: string,
  ownershipReadyToken: string | null,
): boolean {
  return ownershipReadyToken === attachToken;
}
