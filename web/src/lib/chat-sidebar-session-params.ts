/**
 * Build the ``session.create`` params for the sidecar session.
 *
 * Extracted from ChatSidebar's effect so the invariant — close_on_disconnect
 * is set, source is "tool", and the profile is forwarded when present — can be
 * tested without reading component source text. See
 * ``chat-sidebar-session-params.test.ts``.
 *
 * It lives here rather than in the component because a module that exports
 * both components and plain functions breaks React Fast Refresh: the whole
 * module gets remounted on edit instead of hot-swapped. Pure helpers belong
 * beside their tests.
 */
export function sidecarSessionCreateParams(profile?: string): Record<string, unknown> {
  return {
    close_on_disconnect: true,
    source: "tool",
    ...(profile ? { profile } : {}),
  };
}
