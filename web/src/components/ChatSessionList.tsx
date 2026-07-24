/**
 * ChatSessionList — a ChatGPT-style conversation switcher that sits beside
 * the embedded TUI on the dashboard Chat tab.
 *
 * It lists the most recent sessions for the active management profile and
 * lets the user swap between them without leaving the Chat page. Selecting
 * a row sets `/chat?resume=<id>`; ChatPage treats the resume target as part
 * of the PTY identity, so the change tears down the current terminal child
 * and respawns it resuming that conversation (see ChatPage.tsx). The
 * "New session" action clears the resume param, which spawns a fresh PTY.
 *
 * Best-effort, like ChatSidebar: a failed fetch surfaces a small inline
 * error with a retry affordance and the terminal pane keeps working.
 *
 * Beyond switching, each row exposes light management via a context menu
 * (right-click / long-press / a keyboard-reachable kebab): pin, rename,
 * archive, export, delete. Pin state is a synced app-setting; the rest call
 * the same session endpoints the full Sessions page uses. This keeps the
 * common actions one gesture away without leaving the chat context, while
 * the Sessions page remains the home for bulk operations.
 */

import { Button } from "@nous-research/ui/ui/components/button";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  Download,
  MessageSquarePlus,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useSearchParams } from "react-router-dom";

import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import {
  SessionContextMenu,
  type ContextMenuAction,
} from "@/components/SessionContextMenu";
import { useI18n } from "@/i18n";
import { api, authedFetch, type SessionInfo } from "@/lib/api";
import { useAppSettings, togglePinnedSession } from "@/lib/app-settings";
import { cn, timeAgo } from "@/lib/utils";

const SESSION_LIMIT = 30;
const LONG_PRESS_MS = 500;

interface ChatSessionListProps {
  /** Active resume target (the session currently shown in the terminal). */
  activeSessionId: string | null;
  /** Management profile from the dashboard switcher — scopes the listing. */
  profile?: string;
  className?: string;
  /** Optional callback fired after a row is picked (e.g. close mobile sheet). */
  onPicked?: () => void;
  /**
   * Starts a fresh chat. ChatPage supplies its `startFreshDashboardChat`,
   * which clears `?resume` AND bumps the reconnect nonce so a brand-new PTY
   * spawns even when the user is already on an unsaved fresh session. When
   * omitted, we fall back to clearing the resume param ourselves.
   */
  onNewChat?: () => void;
}

function rowLabel(session: SessionInfo, untitled: string): string {
  const title = session.title?.trim();
  if (title && title !== "Untitled") return title;
  const preview = session.preview?.trim();
  if (preview) return preview;
  return untitled;
}

export function ChatSessionList({
  activeSessionId,
  profile,
  className,
  onPicked,
  onNewChat,
}: ChatSessionListProps) {
  const { t } = useI18n();
  const { toast, showToast } = useToast();
  const { pinnedSessions } = useAppSettings();
  const [, setSearchParams] = useSearchParams();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped to force a refetch (after switching, on Refresh, on mount).
  const [reloadNonce, setReloadNonce] = useState(0);

  // Row-level management surfaces.
  const [menu, setMenu] = useState<{ session: SessionInfo; x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingDelete, setPendingDelete] = useState<SessionInfo | null>(null);
  const [deleting, setDeleting] = useState(false);

  // `profile` is read inside the fetch; it's part of the scope key so a
  // profile switch refetches. The empty-string fallback keeps the dep
  // stable when no profile is selected (default profile).
  const scopeKey = profile ?? "";

  // Monotonic request token: only the most recent fetch is allowed to
  // commit state, so a fast profile switch (or Refresh spam) can't land a
  // stale list out of order.
  const reqRef = useRef(0);

  const load = useCallback(() => {
    const myReq = ++reqRef.current;
    setLoading(true);
    setError(null);
    api
      .getSessions(SESSION_LIMIT, 0, scopeKey, "recent")
      .then((res) => {
        if (reqRef.current !== myReq) return;
        setSessions(res.sessions);
      })
      .catch((e: Error) => {
        if (reqRef.current !== myReq) return;
        setError(e.message || "failed to load sessions");
      })
      .finally(() => {
        if (reqRef.current === myReq) setLoading(false);
      });
  }, [scopeKey]);

  useEffect(() => {
    // Dashboard data surfaces fetch from an effect on mount + scope change;
    // keep this local and explicit until the shared lint profile is updated
    // for async loaders (matches FilesPage).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // `reloadNonce` is a manual refetch trigger (Refresh button / row pick).
  }, [load, reloadNonce]);

  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  // Picking a row sets `/chat?resume=<id>`. Re-picking the row already in
  // the terminal is a no-op (avoids a needless PTY teardown).
  const pick = useCallback(
    (id: string) => {
      onPicked?.();
      if (id === activeSessionId) return;
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("resume", id);
          return next;
        },
        { replace: false },
      );
    },
    [activeSessionId, onPicked, setSearchParams],
  );

  // "New chat" prefers ChatPage's robust handler (clears resume + forces a
  // PTY respawn even from an already-fresh session). Fallback: clear the
  // resume param ourselves, which spawns a fresh PTY whenever one was being
  // resumed. Session management (delete/rename/export) lives on the Sessions
  // page; this panel only switches and starts conversations.
  const startNew = useCallback(() => {
    onPicked?.();
    if (onNewChat) {
      onNewChat();
      return;
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("resume");
        return next;
      },
      { replace: false },
    );
  }, [onNewChat, onPicked, setSearchParams]);

  // --- Row management -------------------------------------------------------

  const beginRename = useCallback((session: SessionInfo) => {
    setRenameValue((session.title ?? "").trim());
    setRenamingId(session.id);
  }, []);

  const commitRename = useCallback(
    async (session: SessionInfo) => {
      const next = renameValue.trim();
      setRenamingId(null);
      if (next === (session.title ?? "").trim()) return;
      // Optimistic: reflect the new title immediately, roll back on failure.
      setSessions((prev) =>
        prev?.map((s) => (s.id === session.id ? { ...s, title: next || null } : s)) ?? null,
      );
      try {
        const res = await api.renameSession(session.id, next, profile);
        setSessions((prev) =>
          prev?.map((s) => (s.id === session.id ? { ...s, title: res.title || null } : s)) ?? null,
        );
      } catch {
        setSessions((prev) =>
          prev?.map((s) =>
            s.id === session.id ? { ...s, title: session.title } : s,
          ) ?? null,
        );
        showToast("Could not rename session", "error");
      }
    },
    [profile, renameValue, showToast],
  );

  const toggleArchive = useCallback(
    async (session: SessionInfo) => {
      const nextArchived = !session.archived;
      try {
        await api.archiveSession(session.id, nextArchived, profile);
        // Archived sessions drop out of the (exclude-archived) listing.
        if (nextArchived) {
          setSessions((prev) => prev?.filter((s) => s.id !== session.id) ?? null);
        } else {
          setSessions((prev) =>
            prev?.map((s) => (s.id === session.id ? { ...s, archived: false } : s)) ?? null,
          );
        }
        showToast(nextArchived ? "Session archived" : "Session restored", "success");
      } catch {
        showToast("Could not update session", "error");
      }
    },
    [profile, showToast],
  );

  const exportSession = useCallback(
    async (session: SessionInfo) => {
      try {
        const res = await authedFetch(api.exportSessionUrl(session.id, profile));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `session-${session.id}.json`;
        a.click();
        URL.revokeObjectURL(url);
      } catch {
        showToast("Could not export session", "error");
      }
    },
    [profile, showToast],
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteSession(pendingDelete.id, profile);
      setSessions((prev) => prev?.filter((s) => s.id !== pendingDelete.id) ?? null);
      showToast("Session deleted", "success");
      setPendingDelete(null);
    } catch {
      showToast("Could not delete session", "error");
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, profile, showToast]);

  const openMenuAt = useCallback((session: SessionInfo, x: number, y: number) => {
    setMenu({ session, x, y });
  }, []);

  const menuActions = useMemo<ContextMenuAction[]>(() => {
    if (!menu) return [];
    const s = menu.session;
    const isPinned = pinnedSessions.includes(s.id);
    return [
      {
        key: "pin",
        label: isPinned ? "Unpin" : "Pin to top",
        icon: isPinned ? <PinOff /> : <Pin />,
        onSelect: () => togglePinnedSession(s.id),
      },
      {
        key: "rename",
        label: "Rename",
        icon: <Pencil />,
        onSelect: () => beginRename(s),
      },
      {
        key: "archive",
        label: s.archived ? "Restore" : "Archive",
        icon: s.archived ? <ArchiveRestore /> : <Archive />,
        onSelect: () => void toggleArchive(s),
      },
      {
        key: "export",
        label: "Export JSON",
        icon: <Download />,
        onSelect: () => void exportSession(s),
      },
      {
        key: "delete",
        label: "Delete",
        icon: <Trash2 />,
        destructive: true,
        onSelect: () => setPendingDelete(s),
      },
    ];
  }, [beginRename, exportSession, menu, pinnedSessions, toggleArchive]);

  // Long-press (touch) → open the context menu at the touch point.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPress = useCallback(() => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }, []);

  const content = useMemo(() => {
    if (loading && sessions === null) {
      return (
        <div className="flex items-center justify-center gap-2 px-2 py-6 text-xs text-text-secondary">
          <Spinner /> {t.common.loading}
        </div>
      );
    }
    if (error) {
      return (
        <div className="flex flex-col items-start gap-2 px-2 py-4 text-xs">
          <div className="flex items-start gap-2 text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="wrap-break-word">{error}</span>
          </div>
          <Button size="sm" outlined onClick={reload} prefix={<RefreshCw />}>
            {t.common.retry}
          </Button>
        </div>
      );
    }
    if (!sessions || sessions.length === 0) {
      return (
        <div className="px-2 py-6 text-center text-xs text-text-secondary">
          {t.sessions.noSessions}
        </div>
      );
    }
    // Pinned sessions sort to the top (stable within each group).
    const pinnedSet = new Set(pinnedSessions);
    const ordered = [...sessions].sort(
      (a, b) => Number(pinnedSet.has(b.id)) - Number(pinnedSet.has(a.id)),
    );
    return (
      <div className="flex flex-col gap-0.5">
        {ordered.map((s) => {
          const isActive = s.id === activeSessionId;
          const isPinned = pinnedSet.has(s.id);
          const isRenaming = renamingId === s.id;

          if (isRenaming) {
            return (
              <div key={s.id} className="px-2 py-1.5">
                <input
                  autoFocus
                  onFocus={(event) => event.target.select()}
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onBlur={() => void commitRename(s)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void commitRename(s);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setRenamingId(null);
                    }
                  }}
                  aria-label="Session title"
                  maxLength={200}
                  className="w-full rounded border border-primary/40 bg-transparent px-2 py-1 text-sm outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
                />
              </div>
            );
          }

          const onContextMenu = (event: React.MouseEvent) => {
            event.preventDefault();
            openMenuAt(s, event.clientX, event.clientY);
          };
          const onPointerDown = (event: ReactPointerEvent) => {
            if (event.pointerType !== "touch") return;
            const { clientX, clientY } = event;
            clearPress();
            pressTimer.current = setTimeout(() => {
              openMenuAt(s, clientX, clientY);
            }, LONG_PRESS_MS);
          };

          const label = rowLabel(s, t.sessions.untitledSession);
          return (
            // Stretched-button row: the full-row select control is a SIBLING
            // of the pin/kebab buttons, not their parent — nesting interactive
            // elements is invalid and fails the nested-interactive a11y rule.
            // The label/meta layer sits above the select button (z-10) so text
            // stays readable, but is pointer-events-none so a click on it falls
            // through to the select button; only the action buttons re-enable
            // pointer events.
            <div
              key={s.id}
              onContextMenu={onContextMenu}
              onPointerDown={onPointerDown}
              onPointerUp={clearPress}
              onPointerMove={clearPress}
              onPointerCancel={clearPress}
              className={cn(
                "group relative flex flex-col items-start gap-0.5 rounded px-2 py-1.5",
                "normal-case tracking-normal",
                isActive
                  ? "bg-primary/10 text-foreground border-l-2 border-primary"
                  : "text-text-secondary hover:bg-midground/5 hover:text-foreground",
              )}
            >
              <button
                type="button"
                onClick={() => pick(s.id)}
                aria-current={isActive ? "true" : undefined}
                aria-label={`Open ${label}`}
                className="absolute inset-0 z-0 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/40"
              />
              <span className="pointer-events-none relative z-10 flex w-full min-w-0 items-center gap-1">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {label}
                </span>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    togglePinnedSession(s.id);
                  }}
                  aria-label={isPinned ? "Unpin session" : "Pin session"}
                  aria-pressed={isPinned}
                  className={cn(
                    "pointer-events-auto shrink-0 rounded p-0.5 transition-opacity",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40",
                    isPinned
                      ? "text-primary opacity-100"
                      : "text-text-tertiary opacity-0 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100",
                  )}
                >
                  <Pin className={cn("h-3.5 w-3.5", isPinned && "fill-current")} />
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                    openMenuAt(s, rect.right, rect.bottom);
                  }}
                  aria-label={`Actions for ${label}`}
                  aria-haspopup="menu"
                  className={cn(
                    "pointer-events-auto shrink-0 rounded p-0.5 text-text-tertiary transition-opacity",
                    "opacity-0 hover:text-foreground group-hover:opacity-100",
                    "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40",
                  )}
                >
                  <MoreVertical className="h-3.5 w-3.5" />
                </button>
              </span>
              <span className="pointer-events-none relative z-10 flex w-full items-center gap-1.5 text-[0.6875rem] text-text-tertiary">
                <span>{timeAgo(s.last_active)}</span>
                {s.message_count > 0 && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{s.message_count} msgs</span>
                  </>
                )}
                {s.source && s.source !== "cli" && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="truncate">{s.source}</span>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
    );
  }, [
    activeSessionId,
    clearPress,
    commitRename,
    error,
    loading,
    openMenuAt,
    pick,
    pinnedSessions,
    reload,
    renameValue,
    renamingId,
    sessions,
    t,
  ]);

  return (
    <aside
      className={cn(
        "flex h-full w-full min-w-0 shrink-0 flex-col overflow-hidden",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <span className="text-display text-xs tracking-wider text-text-tertiary">
          {t.sessions.title}
        </span>
        <Button
          ghost
          size="icon"
          onClick={reload}
          aria-label={t.common.refresh}
          title={t.common.refresh}
          className="text-text-secondary hover:text-foreground"
        >
          <RefreshCw className={cn(loading && "animate-spin")} />
        </Button>
      </div>

      <Button
        outlined
        size="sm"
        onClick={startNew}
        prefix={<MessageSquarePlus />}
        className="mx-2 mb-2 justify-center"
      >
        {t.sessions.newChat}
      </Button>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 pb-1">
        {content}
      </div>

      {menu && (
        <SessionContextMenu
          x={menu.x}
          y={menu.y}
          actions={menuActions}
          onClose={() => setMenu(null)}
        />
      )}

      <DeleteConfirmDialog
        open={pendingDelete !== null}
        loading={deleting}
        title={t.sessions.deleteSession}
        description={
          pendingDelete
            ? `Delete "${rowLabel(pendingDelete, t.sessions.untitledSession)}"? This cannot be undone.`
            : ""
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      />

      <Toast toast={toast} />
    </aside>
  );
}
