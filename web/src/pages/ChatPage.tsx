/**
 * ChatPage — embeds `hermes --tui` inside the dashboard.
 *
 *   <div host> (dashboard chrome)                                         .
 *     └─ <div wrapper> (rounded, dark bg, padded — the "terminal window"  .
 *         look that gives the page a distinct visual identity)            .
 *         └─ @xterm/xterm Terminal (WebGL renderer, Unicode 11 widths)    .
 *              │ onData      keystrokes → WebSocket → PTY master          .
 *              │ onResize    terminal resize → `\x1b[RESIZE:cols;rows]`   .
 *              │ write(data) PTY output bytes → VT100 parser              .
 *              ▼                                                          .
 *     WebSocket /api/pty?token=<session>                                  .
 *          ▼                                                              .
 *     FastAPI pty_ws  (hermes_cli/web_server.py)                          .
 *          ▼                                                              .
 *     POSIX PTY → `node ui-tui/dist/entry.js` → tui_gateway + AIAgent     .
 */

import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@nous-research/ui/ui/components/button";
import { Typography } from "@nous-research/ui/ui/components/typography/index";
import { cn } from "@/lib/utils";
import { Copy, MessagesSquare, PanelRight, RotateCcw, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";

import { ChatBubbleFeed } from "@/components/ChatBubbleFeed";
import { ChatModeTransition } from "@/components/ChatModeTransition";
import { ChatSidebar } from "@/components/ChatSidebar";
import { ChatSessionList } from "@/components/ChatSessionList";
import { usePageHeader } from "@/contexts/usePageHeader";
import { useI18n } from "@/i18n";
import { api, type SessionMessage } from "@/lib/api";
import {
  eventChannelForPtyAttach,
  isPtyOwnershipReady,
  ptyOwnershipLockName,
  shouldWaitForExistingPtyLock,
} from "@/lib/chat-channel";
import {
  approvalChoiceKey,
  chatFeedReducer,
  createOptimisticUserMessage,
  hydrateSessionMessages,
  mergeHydratedFeedState,
  parseDashboardEventFrame,
  shouldApplyHydration,
  shouldHandleChannelEvent,
  type ChatFeedMessage,
  type ChatFeedState,
} from "@/lib/chat-feed-model";
import { submitWriteApproval } from "@/lib/write-approval-flow";
import { normalizeSessionTitle } from "@/lib/chat-title";
import {
  shouldQueueSend,
  takeNextQueuedSend,
  type QueuedSend,
} from "@/lib/chat-send-queue";
import {
  planInitialWindow,
  planOlderPage,
  type ChainCursor,
} from "@/lib/chat-history-window";
import { clearUnreadReplies, notifyAssistantReply } from "@/lib/notify";
import { subscribeDashboardEvents } from "@/lib/event-channel-hub";
import {
  createCurrentPtySocket,
  PTY_CONNECTING_TIMEOUT_MS,
  PTY_RECONNECT_INPUT_MESSAGE,
  PTY_RESUME_RECONNECT_THROTTLE_MS,
  type PtyConnectionState,
  shouldBlockPtyInput,
  shouldReconnectPtyOnPageResume,
} from "@/lib/pty-reconnect";
import {
  MOBILE_REPLACEMENT_WINDOW_MS,
  normalizePtyMobileInput,
  shouldTreatInputAsMobileReplacement,
} from "@/lib/pty-mobile-input";
import {
  imageFilesFromTransfer,
  transferMayContainImage,
  uploadChatImage,
} from "@/lib/chatImagePaste";
import { PluginSlot } from "@/plugins";
import { useTheme } from "@/themes";
import { useProfileScope } from "@/contexts/useProfileScope";

// Stable per-browser token identifying THIS chat tab's keep-alive PTY session.
// Sent as ?attach=; lets a refresh/disconnect reattach to the same live process
// instead of spawning a fresh one. sessionStorage keeps independent browser tabs
// from attaching to and replacing each other's live PTY.
// ``rotate`` mints a new token — used when the user explicitly starts a fresh
// session so the old keep-alive PTY is NOT reattached (the registry reaps it).
const PTY_ATTACH_TOKEN_KEY = "hermes.pty.token.chat";
const PTY_EVENT_IDENTITY_KEY = "hermes.pty.event-channel.v1";
function ptyAttachToken(rotate = false): string {
  let t = "";
  if (!rotate) {
    try {
      t = window.sessionStorage.getItem(PTY_ATTACH_TOKEN_KEY) ?? "";
    } catch {
      /* private mode / storage blocked */
    }
  }
  if (!t) {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    t = Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
    try {
      window.sessionStorage.setItem(PTY_ATTACH_TOKEN_KEY, t);
    } catch {
      /* ignore */
    }
  }
  return t;
}

function rotateAlignedPtyAttachToken(): string {
  const token = ptyAttachToken(true);
  try {
    window.sessionStorage.setItem(PTY_EVENT_IDENTITY_KEY, token);
  } catch {
    /* private mode / storage blocked */
  }
  return token;
}

function alignedPtyAttachToken(): string {
  const token = ptyAttachToken();
  try {
    if (window.sessionStorage.getItem(PTY_EVENT_IDENTITY_KEY) === token) {
      return token;
    }
  } catch {
    return token;
  }
  // One-time migration from random per-mount event channels: an existing PTY
  // cannot change its publisher URL, so rotate it once onto the aligned scheme.
  return rotateAlignedPtyAttachToken();
}

// Colors for the terminal body.  Matches the dashboard's dark teal canvas
// with cream foreground — we intentionally don't pick monokai or a loud
// theme, because the TUI's skin engine already paints the content; the
// terminal chrome just needs to sit quietly inside the dashboard.
const DEFAULT_TERMINAL_BACKGROUND = "#000000";
const DEFAULT_TERMINAL_FOREGROUND = "#f0e6d2";

const EMPTY_CHAT_FEED: ChatFeedState = {
  messages: [],
  activeAssistantId: null,
  activeApprovalId: null,
  activeClarifyId: null,
};

function buildTerminalTheme(background: string, foreground: string) {
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground:
      foreground.length === 7 ? `${foreground}44` : foreground,
  };
}

/**
 * CSS width for xterm font tiers.
 *
 * Prefer the terminal host's `clientWidth` — Chrome DevTools device mode often
 * keeps `window.innerWidth` at the full desktop value while the *drawn* layout
 * is phone-sized, which made us pick desktop font sizes (~14px) and look huge.
 */
function terminalTierWidthPx(host: HTMLElement | null): number {
  if (typeof window === "undefined") return 1280;
  const fromHost = host?.clientWidth ?? 0;
  if (fromHost > 2) return Math.round(fromHost);
  const doc = document.documentElement?.clientWidth ?? 0;
  const vv = window.visualViewport;
  const inner = window.innerWidth;
  const vvw = vv?.width ?? inner;
  const layout = Math.min(inner, vvw, doc > 0 ? doc : inner);
  return Math.max(1, Math.round(layout));
}

function terminalFontSizeForWidth(layoutWidthPx: number): number {
  if (layoutWidthPx < 300) return 7;
  if (layoutWidthPx < 360) return 8;
  if (layoutWidthPx < 420) return 9;
  if (layoutWidthPx < 520) return 10;
  if (layoutWidthPx < 720) return 11;
  if (layoutWidthPx < 1024) return 12;
  return 14;
}

function terminalLineHeightForWidth(layoutWidthPx: number): number {
  return layoutWidthPx < 1024 ? 1.02 : 1.15;
}

export default function ChatPage({ isActive = true }: { isActive?: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const imageAttachRef = useRef<(files: File[]) => void>(() => undefined);
  const writeApprovalsInFlightRef = useRef(new Set<string>());
  const [feedState, setFeedState] = useState<ChatFeedState>(EMPTY_CHAT_FEED);
  const [composer, setComposer] = useState("");
  const [rawConsoleOpen, setRawConsoleOpen] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  // Count of in-flight history fetches — drives the feed's "Loading
  // conversation…" state while a selected session hydrates.
  const [hydrationsInFlight, setHydrationsInFlight] = useState(0);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const copyResetTokenRef = useRef(0);
  const optimisticCounterRef = useRef(0);
  const hydratedSessionIdsRef = useRef(new Set<string>());
  const hydrationGenerationRef = useRef(0);
  const eventChannelGenerationRef = useRef(0);
  const activeRuntimeSessionIdRef = useRef<string | null>(null);
  const activeStoredSessionIdRef = useRef<string | null>(null);
  // Exposed to the main metrics-sync effect so it can refit the terminal
  // the moment `isActive` flips back to true (display:none → display:flex
  // collapses the host's box, so ResizeObserver never fires on return).
  const syncMetricsRef = useRef<(() => void) | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  // Lazy-init: the missing-token check happens at construction so the effect
  // body doesn't have to setState (React 19's set-state-in-effect rule).
  // In gated (OAuth) mode the server intentionally omits the session token —
  // the dashboard API layer authenticates the WS via a single-use ticket,
  // so a missing token there is expected, not an error.
  const [banner, setBanner] = useState<string | null>(() =>
    typeof window !== "undefined" &&
    !window.__HERMES_SESSION_TOKEN__ &&
    !window.__HERMES_AUTH_REQUIRED__
      ? "Session token unavailable. Open this page through `hermes dashboard`, not directly."
      : null,
  );
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const forceFreshPtyRef = useRef(false);
  const [ptyAttachIdentity, setPtyAttachIdentity] = useState(() =>
    typeof window !== "undefined" ? alignedPtyAttachToken() : "unavailable",
  );
  const [ownershipReadyToken, setOwnershipReadyToken] = useState<string | null>(
    null,
  );
  const fallbackOwnershipRotatedRef = useRef(false);
  useEffect(() => {
    const claimedToken = ptyAttachIdentity;
    const lockManager =
      typeof navigator !== "undefined" && "locks" in navigator
        ? navigator.locks
        : null;
    if (!lockManager) {
      // Without an atomic cross-tab primitive, fail safe by rotating once for
      // this document rather than risking that a copied token steals a PTY.
      if (!fallbackOwnershipRotatedRef.current) {
        fallbackOwnershipRotatedRef.current = true;
        setPtyAttachIdentity(rotateAlignedPtyAttachToken());
      } else {
        setOwnershipReadyToken(claimedToken);
      }
      return;
    }

    const navigationType = (
      window.performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined
    )?.type;
    const abortLockRequest = new AbortController();
    let cancelled = false;
    let releaseLock: () => void = () => {};
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    void lockManager.request(
      ptyOwnershipLockName(claimedToken),
      {
        mode: "exclusive",
        // A true reload waits for its outgoing document to release the lock.
        // A new/duplicated tab probes atomically and rotates when occupied.
        ifAvailable: !shouldWaitForExistingPtyLock(navigationType),
        signal: abortLockRequest.signal,
      },
      async (lock) => {
        if (cancelled) return;
        if (!lock) {
          setPtyAttachIdentity((current) =>
            current === claimedToken ? rotateAlignedPtyAttachToken() : current,
          );
          return;
        }
        setOwnershipReadyToken(claimedToken);
        await holdLock;
      },
    ).catch((error: unknown) => {
      if (
        cancelled ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return;
      }
      // If the lock API exists but is unusable, retain fail-safe fallback
      // behavior: rotate once for this document before allowing attachment.
      if (!fallbackOwnershipRotatedRef.current) {
        fallbackOwnershipRotatedRef.current = true;
        setPtyAttachIdentity((current) =>
          current === claimedToken ? rotateAlignedPtyAttachToken() : current,
        );
      } else {
        setOwnershipReadyToken(claimedToken);
      }
    });

    return () => {
      cancelled = true;
      abortLockRequest.abort();
      releaseLock();
    };
  }, [ptyAttachIdentity]);
  const blockedInputNoticeRef = useRef(false);
  const lastResumeReconnectAtRef = useRef(0);
  // True from the moment the connect effect begins until the socket resolves
  // (open or close). Guards the page-resume reconnect against firing during
  // the async ticket/URL await gap where wsRef.current is not yet assigned.
  const connectInFlightRef = useRef(false);
  const connectingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ptyInputLineRef = useRef("");
  const mobileReplacementInputUntilRef = useRef(0);
  const [ptyState, setPtyState] =
    useState<PtyConnectionState>("connecting");
  const [readyEventChannel, setReadyEventChannel] = useState<string | null>(null);
  const ptyStateRef = useRef<PtyConnectionState>("connecting");
  const [lastCloseCode, setLastCloseCode] = useState<number | null>(null);
  // NS-504: when the agent process exits cleanly (the user typed `/exit`, or
  // started a new session that ended the current PTY child), the PTY socket
  // closes with a normal code. Before this fix the terminal just printed
  // "[session ended]" and went dead — the only recovery was a full page
  // refresh. `ptyState === "ended"` renders an explicit "Start new session"
  // affordance; clicking it bumps `reconnectNonce`, which is a dependency of
  // the connect effect, so a fresh PTY spawns in place.
  const [reconnectNonce, setReconnectNonce] = useState(0);
  useEffect(() => {
    ptyStateRef.current = ptyState;
  }, [ptyState]);
  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);
  // Windowed hydration state: the accumulated stored messages currently
  // rendered as history, plus the cursor marking where the next older
  // page ends. Reset alongside the feed.
  const historyWindowRef = useRef<{
    chain: string[];
    counts: number[];
    cursor: ChainCursor | null;
    accumulated: SessionMessage[];
    loadedOlder: boolean;
  } | null>(null);
  const [olderHistory, setOlderHistory] = useState<{
    available: boolean;
    loading: boolean;
    /** True once a window has loaded, so "Beginning of session" only
     *  renders for real transcripts. */
    windowed: boolean;
  }>({ available: false, loading: false, windowed: false });
  const resetFreshChatProjection = useCallback(() => {
    hydrationGenerationRef.current += 1;
    activeRuntimeSessionIdRef.current = null;
    activeStoredSessionIdRef.current = null;
    hydratedSessionIdsRef.current.clear();
    historyWindowRef.current = null;
    setOlderHistory({ available: false, loading: false, windowed: false });
    setComposer("");
    setFeedState(EMPTY_CHAT_FEED);
    setAgentRunning(false);
  }, []);
  const reconnectPty = useCallback(() => {
    forceFreshPtyRef.current = false;
    reconnectAttemptRef.current = 0;
    clearReconnectTimer();
    blockedInputNoticeRef.current = false;
    ptyInputLineRef.current = "";
    mobileReplacementInputUntilRef.current = 0;
    setBanner(null);
    setLastCloseCode(null);
    setPtyState("connecting");
    setReconnectNonce((n) => n + 1);
  }, [clearReconnectTimer]);
  const startFreshPty = useCallback(() => {
    forceFreshPtyRef.current = true;
    setPtyAttachIdentity(rotateAlignedPtyAttachToken());
    reconnectAttemptRef.current = 0;
    clearReconnectTimer();
    blockedInputNoticeRef.current = false;
    ptyInputLineRef.current = "";
    mobileReplacementInputUntilRef.current = 0;
    setBanner(null);
    setLastCloseCode(null);
    setPtyState("connecting");
    resetFreshChatProjection();
    setReconnectNonce((n) => n + 1);
  }, [clearReconnectTimer, resetFreshChatProjection]);
  const startFreshDashboardChat = useCallback(() => {
    const next = new URLSearchParams(searchParams);

    next.delete("resume");
    forceFreshPtyRef.current = true;
    setPtyAttachIdentity(rotateAlignedPtyAttachToken());
    reconnectAttemptRef.current = 0;
    clearReconnectTimer();
    blockedInputNoticeRef.current = false;
    ptyInputLineRef.current = "";
    mobileReplacementInputUntilRef.current = 0;
    setSearchParams(next, { replace: true });
    setBanner(null);
    setLastCloseCode(null);
    setPtyState("connecting");
    resetFreshChatProjection();
    setReconnectNonce((n) => n + 1);
  }, [
    clearReconnectTimer,
    resetFreshChatProjection,
    searchParams,
    setSearchParams,
  ]);
  // Raw state for the mobile side-sheet + a derived value that force-
  // closes whenever the chat tab isn't active.  The *derived* value is
  // what side-effects (body-scroll lock, keydown listener, portal render)
  // key on — that way switching to another tab triggers the effect's
  // cleanup, releasing the scroll-lock on /sessions etc.  Returning to
  // /chat re-runs the effect (derived flips back to true) and re-locks.
  // Keying on the raw state would leak the body.overflow="hidden" across
  // tabs because the dep wouldn't change on tab switch.
  const [mobilePanelOpenRaw, setMobilePanelOpenRaw] = useState(false);
  const mobilePanelOpen = isActive && mobilePanelOpenRaw;
  const { setEnd, setTitle } = usePageHeader();
  /** True while chat's mobile panel button occupies the header end slot. */
  const headerEndOwnedRef = useRef(false);
  /** True while chat's session title occupies the header title slot. */
  const headerTitleOwnedRef = useRef(false);
  const [sessionTitleState, setSessionTitleState] = useState<{
    scope: string;
    title: string | null;
  }>({ scope: "", title: null });
  const { t } = useI18n();
  const closeMobilePanel = useCallback(() => setMobilePanelOpenRaw(false), []);
  const modelToolsLabel = useMemo(
    () => `${t.app.modelToolsSheetTitle} ${t.app.modelToolsSheetSubtitle}`,
    [t.app.modelToolsSheetSubtitle, t.app.modelToolsSheetTitle],
  );
  const [portalRoot] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" ? document.body : null,
  );
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(max-width: 1023px)").matches
      : false,
  );

  const { theme } = useTheme();
  const terminalBg = theme.terminalBackground ?? DEFAULT_TERMINAL_BACKGROUND;
  const terminalFg = theme.terminalForeground ?? DEFAULT_TERMINAL_FOREGROUND;
  const terminalTheme = useMemo(
    () => buildTerminalTheme(terminalBg, terminalFg),
    [terminalBg, terminalFg],
  );

  // The dashboard keeps ChatPage mounted persistently so the PTY survives tab
  // switches. That is great for ordinary /chat navigation, but it means query
  // param changes do NOT remount the component. Resume-in-chat from the
  // Sessions page relies on `/chat?resume=<id>` changing at runtime, so we must
  // treat the current resume target as part of the PTY identity and rebuild the
  // terminal session when it changes.
  const resumeParam = searchParams.get("resume");
  // Ref mirror for effects that must read the CURRENT resume target
  // without re-running on every URL change (the event-channel effect).
  const resumeParamRef = useRef(resumeParam);
  useEffect(() => {
    resumeParamRef.current = resumeParam;
  }, [resumeParam]);
  // Profile-scoped chat: spawn the PTY under the globally selected
  // management profile. Changing it remounts the terminal (key below /
  // effect dep) so the user explicitly starts a fresh scoped session.
  const { profile: scopedProfile } = useProfileScope();
  const ptyTargetKey = `${scopedProfile ?? "default"}\0${resumeParam ?? "new"}`;
  const ptyTargetKeyRef = useRef(ptyTargetKey);
  useLayoutEffect(() => {
    if (ptyTargetKeyRef.current === ptyTargetKey) return;
    ptyTargetKeyRef.current = ptyTargetKey;
    forceFreshPtyRef.current = false;
    setPtyAttachIdentity(rotateAlignedPtyAttachToken());
    resetFreshChatProjection();
  }, [ptyTargetKey, resetFreshChatProjection]);
  // The PTY-side event publisher is fixed to the channel chosen when that
  // keep-alive process starts. Derive the subscriber from the same persistent
  // attach identity so reload/reattach cannot silently split the two streams.
  const channel = useMemo(
    () => eventChannelForPtyAttach(ptyAttachIdentity),
    [ptyAttachIdentity],
  );
  const eventSocketReady = readyEventChannel === channel;
  const ptyOwnershipReady = isPtyOwnershipReady(
    ptyAttachIdentity,
    ownershipReadyToken,
  );
  const titleScope = `${channel}\0${reconnectNonce}`;
  const sessionTitle =
    sessionTitleState.scope === titleScope ? sessionTitleState.title : null;
  const handleSessionTitleChange = useCallback(
    (title: string | null) => setSessionTitleState({ scope: titleScope, title }),
    [titleScope],
  );

  // ── Session-chain hydration ─────────────────────────────────────────
  // Resume runs continue under CHILD session ids (the store links them via
  // parent_session_id), so one id's message list is only a fragment of
  // what the user sees as "one conversation". Loading a single id is what
  // made resumed sessions open empty: the first session.info announced the
  // new descendant id, the feed was cleared, and the descendant had no
  // stored messages yet. Hydration therefore always loads the WHOLE chain:
  // walk up to the root via parent_session_id, take the root's descendant
  // path, and concatenate every session's messages in order.
  const sessionChainCacheRef = useRef(new Map<string, string[]>());

  const resolveSessionChain = useCallback(
    async (sessionId: string): Promise<string[]> => {
      const cached = sessionChainCacheRef.current.get(sessionId);
      if (cached) return cached;

      let root = sessionId;
      const seen = new Set([sessionId]);
      for (let hop = 0; hop < 25; hop++) {
        let parent: string | null | undefined;
        try {
          parent = (await api.getSessionDetail(root, scopedProfile))
            .parent_session_id;
        } catch {
          break;
        }
        if (!parent || seen.has(parent)) break;
        seen.add(parent);
        root = parent;
      }

      let chain: string[] = [sessionId];
      try {
        const resp = await api.getSessionLatestDescendant(root, scopedProfile);
        if (resp.path?.length) chain = resp.path;
      } catch {
        // Fall back to the single id — hydration still works, just unchained.
      }
      if (!chain.includes(sessionId)) chain = [...chain, sessionId];
      sessionChainCacheRef.current.set(sessionId, chain);
      return chain;
    },
    [scopedProfile],
  );

  const fetchChainMessages = useCallback(
    async (sessionId: string) => {
      const chain = await resolveSessionChain(sessionId);
      const counts = await Promise.all(
        chain.map((id) =>
          api
            .getSessionDetail(id, scopedProfile)
            .then((detail) => detail.message_count ?? 0)
            .catch(() => 0),
        ),
      );
      const { fetches, cursor } = planInitialWindow(counts);
      const parts = await Promise.all(
        fetches.map((page) =>
          api
            .getSessionMessages(chain[page.chainIndex], scopedProfile, {
              limit: page.limit,
              offset: page.offset,
            })
            .then((response) => response.messages)
            .catch(() => []),
        ),
      );
      const messages = parts.flat();
      historyWindowRef.current = {
        chain,
        counts,
        cursor,
        accumulated: messages,
        loadedOlder: false,
      };
      setOlderHistory({
        available: cursor !== null,
        loading: false,
        windowed: true,
      });
      return { chain, messages };
    },
    [resolveSessionChain, scopedProfile],
  );

  /** Prepend the next older page; triggered from the feed's top sentinel. */
  const loadOlderHistory = useCallback(() => {
    const window = historyWindowRef.current;
    if (!window || !window.cursor) return;
    setOlderHistory((state) =>
      state.loading ? state : { ...state, loading: true },
    );
    const { fetch: page, cursor } = planOlderPage(window.counts, window.cursor);
    void api
      .getSessionMessages(window.chain[page.chainIndex], scopedProfile, {
        limit: page.limit,
        offset: page.offset,
      })
      .then((response) => {
        const current = historyWindowRef.current;
        if (current !== window) return; // feed was reset mid-flight
        current.accumulated = [...response.messages, ...current.accumulated];
        current.cursor = cursor;
        current.loadedOlder = true;
        const history = hydrateSessionMessages(current.accumulated);
        setFeedState((state) => mergeHydratedFeedState(history, state));
        setOlderHistory({
          available: cursor !== null,
          loading: false,
          windowed: true,
        });
      })
      .catch(() => {
        setOlderHistory((state) => ({ ...state, loading: false }));
      });
  }, [scopedProfile]);


  // Structured event relay for the bubble transcript. The PTY remains the
  // execution authority; this subscriber is a read-only projection of the
  // same message/tool/approval stream already used by the native clients.
  useEffect(() => {
    if (!ptyOwnershipReady) return;
    let unmounting = false;
    const eventGeneration = eventChannelGenerationRef.current + 1;
    eventChannelGenerationRef.current = eventGeneration;
    hydrationGenerationRef.current += 1;
    hydratedSessionIdsRef.current.clear();
    activeRuntimeSessionIdRef.current = null;
    activeStoredSessionIdRef.current = null;
    queuedSendsRef.current = [];
    sessionChainCacheRef.current.clear();
    historyWindowRef.current = null;
    queueMicrotask(() => {
      if (!unmounting) {
        setOlderHistory({ available: false, loading: false, windowed: false });
        setFeedState(EMPTY_CHAT_FEED);
        setAgentRunning(false);
      }
    });

    const hydrateStoredSession = (
      sessionId: string,
      previousSessionId?: string | null,
    ) => {
      if (!sessionId || hydratedSessionIdsRef.current.has(sessionId)) return;
      hydratedSessionIdsRef.current.add(sessionId);
      const requestGeneration = hydrationGenerationRef.current;
      setHydrationsInFlight((count) => count + 1);
      void fetchChainMessages(sessionId)
        .then(({ chain, messages }) => {
          if (
            unmounting ||
            !shouldApplyHydration(
              requestGeneration,
              hydrationGenerationRef.current,
              sessionId,
              activeStoredSessionIdRef.current,
            )
          ) {
            return;
          }
          const history = hydrateSessionMessages(messages);
          setFeedState((state) => {
            // A stored-id change that ISN'T part of the visible chain
            // (e.g. /new typed into the TUI) starts from a clean feed.
            // Continuations — resume runs rotating to a child session id —
            // keep the live bubbles and swap in the full-chain history,
            // instead of the old behavior of wiping the transcript the
            // moment the descendant id was announced.
            const base =
              previousSessionId && !chain.includes(previousSessionId)
                ? EMPTY_CHAT_FEED
                : state;
            return mergeHydratedFeedState(history, base);
          });
        })
        .catch(() => {
          if (
            shouldApplyHydration(
              requestGeneration,
              hydrationGenerationRef.current,
              sessionId,
              activeStoredSessionIdRef.current,
            )
          ) {
            hydratedSessionIdsRef.current.delete(sessionId);
          }
        })
        .finally(() => {
          setHydrationsInFlight((count) => Math.max(0, count - 1));
        });
    };

    // Shared per-channel hub — one resilient socket multiplexed with the
    // ChatSidebar subscription instead of a second parallel WebSocket.
    // Seed hydration from the resume target immediately. The PTY's first
    // session.info normally re-triggers hydration after the reset above,
    // but event delivery can lag or drop entirely (slow TUI boot, publisher
    // reconnect) — and the reset must never leave an already-fetched
    // transcript wiped with nothing scheduled to restore it. Chain-based
    // hydration makes this idempotent with whatever session.info later
    // announces.
    if (resumeParamRef.current) {
      activeStoredSessionIdRef.current = resumeParamRef.current;
      hydrateStoredSession(resumeParamRef.current);
    }

    const stopEventSocket = subscribeDashboardEvents(channel, {
      onMessage: (raw) => {
        if (
          !shouldHandleChannelEvent(
            eventGeneration,
            eventChannelGenerationRef.current,
            unmounting,
          )
        ) {
          return;
        }
        const event = parseDashboardEventFrame(String(raw.data));
        if (!event) return;

        const runtimeSessionId = event.sessionId ?? null;
        const storedSessionId = event.payload?.session_id;
        if (event.type === "session.info") {
          if (
            activeRuntimeSessionIdRef.current &&
            runtimeSessionId &&
            activeRuntimeSessionIdRef.current !== runtimeSessionId
          ) {
            return;
          }
          if (!activeRuntimeSessionIdRef.current && runtimeSessionId) {
            activeRuntimeSessionIdRef.current = runtimeSessionId;
          }

          if (typeof storedSessionId === "string" && storedSessionId) {
            const previousStoredSessionId = activeStoredSessionIdRef.current;
            if (previousStoredSessionId !== storedSessionId) {
              hydrationGenerationRef.current += 1;
              hydratedSessionIdsRef.current.clear();
              // No synchronous wipe here: whether this id change is a
              // continuation (resume descendant — keep the transcript) or
              // a genuinely fresh session (clear it) is decided by the
              // chain lookup inside hydrateStoredSession.
            }
            activeStoredSessionIdRef.current = storedSessionId;
            hydrateStoredSession(storedSessionId, previousStoredSessionId);
          }
          if (typeof event.payload?.running === "boolean") {
            setAgentRunning(event.payload.running);
          }
        } else {
          // The channel isolates this PTY. After a browser reload, a live event
          // can arrive before another session.info frame, so use its runtime ID
          // as the active one while still rejecting mismatches afterward.
          if (!activeRuntimeSessionIdRef.current && runtimeSessionId) {
            activeRuntimeSessionIdRef.current = runtimeSessionId;
          }
          if (
            runtimeSessionId &&
            activeRuntimeSessionIdRef.current !== runtimeSessionId
          ) {
            return;
          }
        }

        const feedEvent =
          event.type === "write_approval.request"
            ? {
                ...event,
                payload: {
                  ...event.payload,
                  profile: scopedProfile ?? "current",
                },
              }
            : event;
        setFeedState((state) => chatFeedReducer(state, feedEvent));
        if (event.type === "message.start") setAgentRunning(true);
        if (event.type === "message.complete" || event.type === "error") {
          setAgentRunning(false);
          if (event.type === "message.complete") {
            // Replies only — tool calls and streaming deltas never notify.
            const payload = event.payload as {
              text?: unknown;
              rendered?: unknown;
            };
            const replyText =
              typeof payload?.text === "string" && payload.text
                ? payload.text
                : typeof payload?.rendered === "string"
                  ? payload.rendered
                  : "";
            notifyAssistantReply(replyText);
          }
          const sessionId = activeStoredSessionIdRef.current;
          // Post-turn reconcile refetches the newest window. Skip it once
          // the user has paged older history in — a window refetch would
          // collapse those pages, and the live bubbles already carry the
          // completed turn verbatim.
          if (sessionId && !historyWindowRef.current?.loadedOlder) {
            hydratedSessionIdsRef.current.delete(sessionId);
            hydrateStoredSession(sessionId);
          }
        }
      },
      onConnected: (reconnected) => {
        setReadyEventChannel(channel);
        setBanner((current) =>
          current?.startsWith("Structured chat feed") ? null : current,
        );
        const sessionId = activeStoredSessionIdRef.current;
        if (sessionId) {
          if (reconnected) hydrationGenerationRef.current += 1;
          hydratedSessionIdsRef.current.delete(sessionId);
          hydrateStoredSession(sessionId);
        }
      },
      onTerminalFailure: ({ code, error }) => {
        if (
          !shouldHandleChannelEvent(
            eventGeneration,
            eventChannelGenerationRef.current,
            unmounting,
          )
        ) {
          return;
        }
        setReadyEventChannel((current) =>
          current === channel ? null : current,
        );
        setPtyState("closed");
        const detail =
          error instanceof Error
            ? error.message
            : code === 4403
              ? "request host/origin was refused"
              : "session authentication was rejected";
        setBanner(`Structured chat feed unavailable: ${detail}. Reload to authenticate.`);
      },
      onDisconnected: () => {
        if (
          shouldHandleChannelEvent(
            eventGeneration,
            eventChannelGenerationRef.current,
            unmounting,
          )
        ) {
          setBanner((current) =>
            current && !current.startsWith("Structured chat feed")
              ? current
              : "Structured chat feed reconnecting. Raw console remains available.",
          );
        }
      },
    });

    return () => {
      unmounting = true;
      if (eventChannelGenerationRef.current === eventGeneration) {
        eventChannelGenerationRef.current += 1;
      }
      hydrationGenerationRef.current += 1;
      stopEventSocket();
    };
  }, [channel, ptyOwnershipReady, scopedProfile, fetchChainMessages]);

  // Restore the selected session into semantic bubbles before new live events
  // arrive. Stored system/tool rows are retained rather than prettified away.
  useEffect(() => {
    if (!resumeParam) return;
    if (activeStoredSessionIdRef.current !== resumeParam) {
      hydrationGenerationRef.current += 1;
      hydratedSessionIdsRef.current.clear();
      activeStoredSessionIdRef.current = resumeParam;
    }
    if (hydratedSessionIdsRef.current.has(resumeParam)) return;
    hydratedSessionIdsRef.current.add(resumeParam);
    const requestGeneration = hydrationGenerationRef.current;
    let cancelled = false;
    setHydrationsInFlight((count) => count + 1);
    void fetchChainMessages(resumeParam)
      .then(({ messages }) => {
        if (
          cancelled ||
          !shouldApplyHydration(
            requestGeneration,
            hydrationGenerationRef.current,
            resumeParam,
            activeStoredSessionIdRef.current,
          )
        ) {
          return;
        }
        const history = hydrateSessionMessages(messages);
        setFeedState((state) => mergeHydratedFeedState(history, state));
      })
      .catch(() => {
        if (
          shouldApplyHydration(
            requestGeneration,
            hydrationGenerationRef.current,
            resumeParam,
            activeStoredSessionIdRef.current,
          )
        ) {
          hydratedSessionIdsRef.current.delete(resumeParam);
        }
        // The live event stream and lossless raw console remain usable.
      })
      .finally(() => {
        setHydrationsInFlight((count) => Math.max(0, count - 1));
      });
    return () => {
      cancelled = true;
    };
  }, [resumeParam, scopedProfile, channel, fetchChainMessages]);

  const sendPtyText = useCallback((text: string, submit = true): boolean => {
    const ws = wsRef.current;
    const term = termRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !term) return false;
    term.paste(text);
    if (submit) {
      window.setTimeout(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send("\r");
        }
      }, 40);
    }
    return true;
  }, []);

  // Messages composed while the agent was mid-run, waiting to start their
  // own turn. Flushed one per run-completion by the effect below.
  const queuedSendsRef = useRef<QueuedSend[]>([]);

  const markOptimisticFailed = useCallback((id: string) => {
    setFeedState((state) => ({
      ...state,
      messages: state.messages.map((message) =>
        message.id === id ? { ...message, status: "error" } : message,
      ),
    }));
  }, []);

  const submitComposer = useCallback(() => {
    const text = composer.trim();
    if (!text) return;
    const now = Date.now();
    const isSlashCommand = text.startsWith("/");
    const id = `user-${now}-${optimisticCounterRef.current++}`;
    const activeClarify = feedState.activeClarifyId
      ? feedState.messages.find((message) => message.id === feedState.activeClarifyId)
      : null;
    // Show EVERY submitted line as a user bubble, slash commands included —
    // the user should see the command they sent, and it still dispatches to
    // the agent below. A plain message typed mid-run queues ("waiting");
    // slash commands dispatch immediately, so they open as "sending".
    setFeedState((state) => ({
      ...state,
      messages: [
        ...state.messages,
        {
          ...createOptimisticUserMessage(text, id, now),
          status: agentRunning && !isSlashCommand ? "waiting" : "sending",
        },
      ],
    }));
    setComposer("");

    let sent = false;
    if (activeClarify && activeClarify.choices?.length) {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        // Move to "Other", confirm, then paste the free-form answer.
        ws.send("\x1b[B".repeat(activeClarify.choices.length));
        ws.send("\r");
        window.setTimeout(() => sendPtyText(text), 50);
        sent = true;
      }
    } else if (
      shouldQueueSend({
        agentRunning,
        isSlashCommand,
        answeringClarify: Boolean(activeClarify),
      })
    ) {
      // Mid-run: hold the message locally (bubble shows "Waiting to send")
      // and let the flush effect below deliver it when this run completes.
      // Writing it to the PTY now would steer the active turn instead of
      // starting a new one.
      queuedSendsRef.current.push({ id, text });
      sent = true;
    } else {
      sent = sendPtyText(text);
    }

    if (!sent) {
      markOptimisticFailed(id);
      return;
    }

    // Slash commands are dispatched straight to the PTY and usually produce
    // no assistant reply to acknowledge the bubble, so settle it to "sent"
    // now that it's on the wire. Plain messages keep "sending" until the
    // agent's response acknowledges them.
    if (isSlashCommand) {
      setFeedState((state) => ({
        ...state,
        messages: state.messages.map((message) =>
          message.id === id ? { ...message, status: "sent" } : message,
        ),
      }));
    }

    if (activeClarify) {
      setFeedState((state) => {
        const resolved = chatFeedReducer(state, {
          type: "clarify.resolved",
          payload: { answer: text },
        });
        return {
          ...resolved,
          messages: resolved.messages.map((message) =>
            message.id === id ? { ...message, status: "sent" } : message,
          ),
        };
      });
    }
  }, [agentRunning, composer, feedState.activeClarifyId, feedState.messages, markOptimisticFailed, sendPtyText]);

  // Flush the send queue one message per idle transition: the first queued
  // message goes out when the current run completes; its own completion
  // re-fires this effect for the next one, preserving order and keeping
  // each message a fresh turn rather than a steer.
  useEffect(() => {
    const next = takeNextQueuedSend(queuedSendsRef.current, agentRunning);
    if (!next) return;
    if (sendPtyText(next.text)) {
      setFeedState((state) => ({
        ...state,
        messages: state.messages.map((message) =>
          message.id === next.id ? { ...message, status: "sending" } : message,
        ),
      }));
    } else {
      markOptimisticFailed(next.id);
    }
  }, [agentRunning, markOptimisticFailed, sendPtyText]);

  const stopAgent = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send("\x03");
  }, []);

  const handleCopyLast = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send("/copy");
    window.setTimeout(() => {
      const current = wsRef.current;
      if (current?.readyState === WebSocket.OPEN) current.send("\r");
    }, 100);
    setCopyState("copied");
    const resetToken = ++copyResetTokenRef.current;
    window.setTimeout(() => {
      if (copyResetTokenRef.current === resetToken) setCopyState("idle");
    }, 1500);
    termRef.current?.focus();
  }, []);

  const retryMessage = useCallback(
    (message: ChatFeedMessage) => {
      if (!sendPtyText(message.text)) return;
      setFeedState((state) => ({
        ...state,
        messages: state.messages.map((item) =>
          item.id === message.id ? { ...item, status: "sending" } : item,
        ),
      }));
    },
    [sendPtyText],
  );

  const answerApproval = useCallback(
    (
      choice: "once" | "session" | "always" | "deny",
      message: ChatFeedMessage,
    ) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(approvalChoiceKey(choice, message.allowPermanent !== false));
      setFeedState((state) =>
        chatFeedReducer(state, {
          type: "approval.resolved",
          payload: { choice },
        }),
      );
    },
    [],
  );

  const answerWriteApproval = useCallback(
    (choice: "approve" | "reject", message: ChatFeedMessage) => {
      void submitWriteApproval({
        choice,
        dispatch: (event) => {
          setFeedState((state) => chatFeedReducer(state, event));
        },
        inFlight: writeApprovalsInFlightRef.current,
        message,
        profile: scopedProfile ?? undefined,
        resolve: api.resolveWriteApproval,
      });
    },
    [scopedProfile],
  );

  const answerClarify = useCallback((answer: string, message: ChatFeedMessage) => {
    const ws = wsRef.current;
    const index = message.choices?.indexOf(answer) ?? -1;
    if (!ws || ws.readyState !== WebSocket.OPEN || index < 0) return;
    ws.send(String(index + 1));
    setFeedState((state) =>
      chatFeedReducer(state, {
        type: "clarify.resolved",
        payload: { answer },
      }),
    );
  }, []);

  useEffect(() => {
    // Same ownership rule as the header end slot: the hidden chat host
    // must never null a title another page just set.
    if (!isActive) {
      if (headerTitleOwnedRef.current) {
        headerTitleOwnedRef.current = false;
        setTitle(null);
      }
      return;
    }

    headerTitleOwnedRef.current = true;
    setTitle(sessionTitle);
    return () => {
      if (headerTitleOwnedRef.current) {
        headerTitleOwnedRef.current = false;
        setTitle(null);
      }
    };
  }, [isActive, sessionTitle, setTitle]);

  // Unread-reply badge clears the moment the chat is actually in view.
  useEffect(() => {
    if (!isActive) return;
    const clearIfVisible = () => {
      if (!document.hidden) clearUnreadReplies();
    };
    clearIfVisible();
    document.addEventListener("visibilitychange", clearIfVisible);
    return () =>
      document.removeEventListener("visibilitychange", clearIfVisible);
  }, [isActive]);

  useEffect(() => {
    if (!resumeParam) return;

    let cancelled = false;

    api
      .getSessionDetail(resumeParam, scopedProfile)
      .then((session) => {
        if (cancelled) return;
        handleSessionTitleChange(normalizeSessionTitle(session.title));
      })
      .catch(() => {
        // Best-effort: the PTY-side session.info stream can still supply it.
      });

    return () => {
      cancelled = true;
    };
  }, [resumeParam, scopedProfile, handleSessionTitleChange]);

  useEffect(() => {
    if (!resumeParam) return;

    let cancelled = false;

    api
      .getSessionLatestDescendant(resumeParam, scopedProfile)
      .then((res) => {
        if (cancelled || !res.session_id || res.session_id === resumeParam) {
          return;
        }

        const next = new URLSearchParams(searchParams);
        next.set("resume", res.session_id);
        setSearchParams(next, { replace: true });
      })
      .catch(() => {
        // Best-effort: old servers or missing sessions should not block chat.
      });

    return () => {
      cancelled = true;
    };
  }, [resumeParam, scopedProfile, searchParams, setSearchParams]);

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 1023px)");
    const sync = () => setNarrow(mql.matches);
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!mobilePanelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMobilePanel();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [mobilePanelOpen, closeMobilePanel]);

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setMobilePanelOpenRaw(false);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    // When hidden (non-chat tab) or wide, another page owns the header's
    // end slot. Only clear it when WE set it — the persistent chat host
    // mounts on every route, and an unconditional setEnd(null) here wiped
    // the active page's header button on hard loads (its effect runs
    // after the routed page's).
    if (!isActive || !narrow) {
      if (headerEndOwnedRef.current) {
        headerEndOwnedRef.current = false;
        setEnd(null);
      }
      return;
    }
    headerEndOwnedRef.current = true;
    setEnd(
      <Button
        ghost
        onClick={() => setMobilePanelOpenRaw(true)}
        aria-expanded={mobilePanelOpen}
        aria-controls="chat-side-panel"
        className={cn(
          "shrink-0 rounded border border-current/20",
          "px-2 py-1 text-xs font-medium tracking-wide",
          "text-text-secondary hover:text-midground hover:bg-midground/5",
        )}
      >
        <span className="inline-flex items-center gap-1.5">
          <PanelRight className="h-3 w-3 shrink-0" />
          {modelToolsLabel}
        </span>
      </Button>,
    );
    return () => {
      if (headerEndOwnedRef.current) {
        headerEndOwnedRef.current = false;
        setEnd(null);
      }
    };
  }, [isActive, narrow, mobilePanelOpen, modelToolsLabel, setEnd]);

  useEffect(() => {
    if (!eventSocketReady) return;
    const host = hostRef.current;
    if (!host) return;

    const token = window.__HERMES_SESSION_TOKEN__;
    const gated = !!window.__HERMES_AUTH_REQUIRED__;
    // Banner already initialised above; just bail before wiring xterm/WS.
    // In gated mode the token is absent by design — api.buildWsUrl() mints
    // a WS ticket instead, so don't bail; let the effect reach that path.
    if (!token && !gated) {
      return;
    }

    const tierW0 = terminalTierWidthPx(host);
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily:
        "'JetBrains Mono', 'Cascadia Mono', 'Fira Code', 'MesloLGS NF', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
      fontSize: terminalFontSizeForWidth(tierW0),
      lineHeight: terminalLineHeightForWidth(tierW0),
      letterSpacing: 0,
      fontWeight: "400",
      fontWeightBold: "700",
      macOptionIsMeta: true,
      // Hold Option (Alt on Linux/Windows) to force native text selection
      // even when the inner Imperator TUI has enabled xterm mouse-events
      // mode (CSI ?1000h family). Without this, click-and-drag in the
      // chat canvas selects nothing and Cmd+C falls back to copying the
      // entire visible buffer, which is rarely what the user wants.
      // See #25720.
      macOptionClickForcesSelection: true,
      // Right-click selects the word under the pointer. xterm.js default
      // is false; enabling it gives users a single-action selection
      // path on top of the modifier-based bypass above.
      rightClickSelectsWord: true,
      // Browser-embedded chat runs the TUI in inline mode. Keep transcript
      // history in xterm.js so the browser wheel can scroll it directly.
      scrollback: 5000,
      theme: terminalTheme,
    });
    termRef.current = term;

    // --- Clipboard integration ---------------------------------------
    //
    // Four independent paths all route to the system clipboard:
    //
    //   1. **Selection → Ctrl+C (or Cmd+C on macOS).**  Ink's own handler
    //      in useInputHandlers.ts turns Ctrl+C into a copy when the
    //      terminal has a selection, then emits an OSC 52 escape.  Our
    //      OSC 52 handler below decodes that escape and writes to the
    //      browser clipboard — so the flow works just like it does in
    //      `hermes --tui`.
    //
    //   2. **Ctrl/Cmd+Shift+C.**  Belt-and-suspenders shortcut that
    //      operates directly on xterm's selection, useful if the TUI
    //      ever stops listening (e.g. overlays / pickers) or if the user
    //      has selected with the mouse outside of Ink's selection model.
    //
    //   3. **Ctrl/Cmd+Shift+V.**  Prefers clipboard.read() for images
    //      (upload → `/image`), else readText() into term.paste().
    //      preventDefault here suppresses the DOM paste event, so image
    //      handling must live in this key path — not only the host
    //      listener below.
    //
    //   4. **DOM paste / drop on the host.**  Bare Ctrl+V and context-menu
    //      paste fire a ClipboardEvent; drag-drop lands files. Image
    //      payloads upload to HERMES_HOME/images then drive `/image`.
    //
    // OSC 52 reads (terminal asking to read the clipboard) are not
    // supported — that would let any content the TUI renders exfiltrate
    // the user's clipboard.
    term.parser.registerOscHandler(52, (data) => {
      // Format: "<targets>;<base64 | '?'>"
      const semi = data.indexOf(";");
      if (semi < 0) return false;
      const payload = data.slice(semi + 1);
      if (payload === "?" || payload === "") return false; // read/clear — ignore
      try {
        const binary = atob(payload);
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        const text = new TextDecoder("utf-8").decode(bytes);
        navigator.clipboard.writeText(text).catch((err) => {
          // Most common reason: the Clipboard API requires a user gesture.
          // This can fail when the OSC 52 response arrives outside the
          // original keydown event's activation. Log to aid debugging.
          console.warn("[dashboard clipboard] OSC 52 write failed:", err.message);
        });
      } catch {
        console.warn("[dashboard clipboard] malformed OSC 52 payload");
      }
      return true;
    });

    const isMac =
      typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

    // ── Image paste / drop ───────────────────────────────────────────────
    // The Chat tab is an xterm mirror of a TUI inside the gateway. Server-side
    // clipboard.paste / xclip never see the browser clipboard, so image paste
    // must upload browser bytes to HERMES_HOME/images, then drive `/image`
    // over the PTY (same burst-then-Return timing as composer submission).
    let imageUploadDisposed = false;
    const pasteDelay = () =>
      new Promise<void>((resolve) => window.setTimeout(resolve, 40));
    const reportImageUploadError = (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[dashboard chat] image upload failed:", message);
      setBanner(`Image upload failed: ${message}`);
    };
    const driveImageAttach = async (paths: string[]) => {
      for (const path of paths) {
        if (imageUploadDisposed) return;
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          setBanner(
            "Image uploaded, but chat is not connected — try again.",
          );
          return;
        }
        ws.send(`/image ${path}`);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
        const s = wsRef.current;
        if (!s || s.readyState !== WebSocket.OPEN) return;
        s.send("\r");
        await pasteDelay();
      }
      term.focus();
    };
    const uploadAndAttachImages = (files: File[]) => {
      if (!files.length) return;
      void (async () => {
        const paths: string[] = [];
        for (const file of files) {
          const uploaded = await uploadChatImage(file, scopedProfile);
          if (imageUploadDisposed) return;
          paths.push(uploaded.path);
        }
        await driveImageAttach(paths);
      })().catch(reportImageUploadError);
    };
    imageAttachRef.current = uploadAndAttachImages;
    const handleBrowserPaste = (ev: ClipboardEvent) => {
      const files = imageFilesFromTransfer(ev.clipboardData);
      if (!files.length) return;
      ev.preventDefault();
      ev.stopPropagation();
      uploadAndAttachImages(files);
    };
    const handleBrowserDragOver = (ev: DragEvent) => {
      if (!transferMayContainImage(ev.dataTransfer)) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
    };
    const handleBrowserDrop = (ev: DragEvent) => {
      const files = imageFilesFromTransfer(ev.dataTransfer);
      if (!files.length) return;
      ev.preventDefault();
      ev.stopPropagation();
      uploadAndAttachImages(files);
    };
    host.addEventListener("paste", handleBrowserPaste, { capture: true });
    host.addEventListener("dragover", handleBrowserDragOver, { capture: true });
    host.addEventListener("drop", handleBrowserDrop, { capture: true });

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;

      // Copy: Cmd+C on macOS, Ctrl+Shift+C on other platforms. Bare Ctrl+C
      // is reserved for SIGINT to the TUI child — matches xterm / gnome-terminal /
      // konsole / Windows Terminal. Ctrl+Shift+C only copies if a selection exists;
      // without a selection it passes through to the TUI so agents can still
      // react to the keypress.
      // Paste: Cmd+Shift+V on macOS, Ctrl+Shift+V on others.
      const copyModifier = isMac ? ev.metaKey : ev.ctrlKey && ev.shiftKey;
      const pasteModifier = isMac ? ev.metaKey : ev.ctrlKey && ev.shiftKey;

      if (copyModifier && ev.key.toLowerCase() === "c") {
        const sel = term.getSelection();
        if (sel) {
          // Direct writeText inside the keydown handler preserves the user
          // gesture — async round-trips through OSC 52 can lose activation
          // and fail with "Document is not focused".
          navigator.clipboard.writeText(sel).catch((err) => {
            console.warn("[dashboard clipboard] direct copy failed:", err.message);
          });
          // Clear xterm.js's highlight after copy (matches gnome-terminal).
          term.clearSelection();
          ev.preventDefault();
          return false;
        }
        // No selection → fall through so the TUI receives Ctrl+Shift+C
        // (or the bare ev if the user used a different modifier).
      }

      if (pasteModifier && ev.key.toLowerCase() === "v") {
        // preventDefault suppresses the DOM paste event, so image paste must
        // be handled here via clipboard.read() — readText() alone misses
        // image-only clipboards (the Discord / #24860 failure mode).
        ev.preventDefault();
        void (async () => {
          try {
            const read = navigator.clipboard?.read;
            if (typeof read === "function") {
              const items = await read.call(navigator.clipboard);
              const files: File[] = [];
              for (const item of items) {
                const type = item.types.find((t) => t.startsWith("image/"));
                if (!type) continue;
                const blob = await item.getType(type);
                const ext = type.split("/")[1]?.split("+")[0] || "png";
                files.push(
                  new File([blob], `clipboard.${ext}`, { type }),
                );
              }
              if (files.length) {
                uploadAndAttachImages(files);
                return;
              }
            }
          } catch {
            /* fall through to text paste */
          }
          try {
            const text = await navigator.clipboard.readText();
            if (text) term.paste(text);
          } catch (err) {
            const message =
              err instanceof Error ? err.message : String(err);
            console.warn("[dashboard clipboard] paste failed:", message);
          }
        })();
        return false;
      }

      return true;
    });

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);

    // Dashboard chat should scroll the browser-side transcript, not send
    // mouse-wheel protocol bytes through the PTY.
    term.attachCustomWheelEventHandler((ev) => {
      const delta = ev.deltaY;
      if (!delta) {
        return false;
      }

      const step = Math.max(1, Math.round(Math.abs(delta) / 50));
      term.scrollLines(delta > 0 ? step : -step);

      ev.preventDefault();
      ev.stopPropagation();
      return false;
    });

    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";

    term.loadAddon(new WebLinksAddon());

    let mobileInputCleanup: (() => void) | null = null;
    term.open(host);

    const textarea = term.textarea;
    if (textarea) {
      textarea.setAttribute("autocomplete", "off");
      textarea.setAttribute("autocorrect", "off");
      textarea.setAttribute("autocapitalize", "off");
      textarea.setAttribute("spellcheck", "false");

      const isMobileLike =
        typeof navigator !== "undefined" &&
        /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
      const markReplacementInput = (ev: Event) => {
        const input = ev as InputEvent;
        if (
          shouldTreatInputAsMobileReplacement(
            input.inputType,
            input.data,
            isMobileLike,
          )
        ) {
          mobileReplacementInputUntilRef.current = Date.now() + MOBILE_REPLACEMENT_WINDOW_MS;
        }
      };
      const markCompositionEnd = () => {
        mobileReplacementInputUntilRef.current = Date.now() + MOBILE_REPLACEMENT_WINDOW_MS;
      };

      textarea.addEventListener("beforeinput", markReplacementInput, true);
      textarea.addEventListener("compositionend", markCompositionEnd, true);
      mobileInputCleanup = () => {
        textarea.removeEventListener("beforeinput", markReplacementInput, true);
        textarea.removeEventListener("compositionend", markCompositionEnd, true);
      };
    }

    // WebGL draws from a texture atlas sized with device pixels. On phones and
    // in DevTools device mode that often produces *visually* much larger cells
    // than `fontSize` suggests — users see "huge" text even at 7–9px settings.
    // The canvas/DOM renderer tracks `fontSize` faithfully; use it for narrow
    // hosts.  Wide layouts still get WebGL for crisp box-drawing.
    const useWebgl = terminalTierWidthPx(host) >= 768;
    if (useWebgl) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch (err) {
        console.warn(
          "[hermes-chat] WebGL renderer unavailable; falling back to default",
          err,
        );
      }
    }

    // Initial fit + resize observer.  fit.fit() reads the container's
    // current bounding box and resizes the terminal grid to match.
    //
    // The subtle bit: the dashboard has CSS transitions on the container
    // (backdrop fade-in, rounded corners settling as fonts load).  If we
    // call fit() at mount time, the bounding box we measure is often 1-2
    // cell widths off from the final size.  ResizeObserver *does* fire
    // when the container settles, but if the pixel delta happens to be
    // smaller than one cell's width, fit() computes the same integer
    // (cols, rows) as before and doesn't emit onResize — so the PTY
    // never learns the final size.  Users see truncated long lines until
    // they resize the browser window.
    //
    // We force one extra fit + explicit RESIZE send after two animation
    // frames.  rAF→rAF guarantees one layout commit between the two
    // callbacks, giving CSS transitions and font metrics time to finalize
    // before we take the authoritative measurement.
    let hostSyncRaf = 0;
    const scheduleHostSync = () => {
      if (hostSyncRaf) return;
      hostSyncRaf = requestAnimationFrame(() => {
        hostSyncRaf = 0;
        syncTerminalMetrics();
      });
    };

    let metricsDebounce: ReturnType<typeof setTimeout> | null = null;
    const syncTerminalMetrics = () => {
      // display:none hosts have clientWidth/Height = 0, which fit() turns
      // into a 1x1 terminal.  Skip entirely while hidden; the visibility
      // effect below runs another fit as soon as the tab is shown again.
      if (!host.isConnected || host.clientWidth <= 0 || host.clientHeight <= 0) {
        return;
      }
      const w = terminalTierWidthPx(host);
      const nextSize = terminalFontSizeForWidth(w);
      const nextLh = terminalLineHeightForWidth(w);
      const fontChanged =
        term.options.fontSize !== nextSize ||
        term.options.lineHeight !== nextLh;
      if (fontChanged) {
        term.options.fontSize = nextSize;
        term.options.lineHeight = nextLh;
      }
      try {
        fit.fit();
      } catch {
        return;
      }
      if (fontChanged && term.rows > 0) {
        try {
          term.refresh(0, term.rows - 1);
        } catch {
          /* ignore */
        }
      }
      if (
        fontChanged &&
        wsRef.current &&
        wsRef.current.readyState === WebSocket.OPEN
      ) {
        wsRef.current.send(`\x1b[RESIZE:${term.cols};${term.rows}]`);
      }
    };
    syncMetricsRef.current = syncTerminalMetrics;

    const scheduleSyncTerminalMetrics = () => {
      if (metricsDebounce) clearTimeout(metricsDebounce);
      metricsDebounce = setTimeout(() => {
        metricsDebounce = null;
        syncTerminalMetrics();
      }, 60);
    };

    const ro = new ResizeObserver(() => scheduleHostSync());
    ro.observe(host);

    window.addEventListener("resize", scheduleSyncTerminalMetrics);
    window.visualViewport?.addEventListener("resize", scheduleSyncTerminalMetrics);
    scheduleHostSync();
    requestAnimationFrame(() => scheduleHostSync());

    // Double-rAF authoritative fit.  On the second frame the layout has
    // committed at least once since mount; fit.fit() then reads the
    // stable container size.  We always send a RESIZE escape afterwards
    // (even if fit's cols/rows didn't change, so the PTY has the same
    // dims registered as our JS state — prevents a drift where Ink
    // thinks the terminal is one col bigger than what's on screen).
    let settleRaf1 = 0;
    let settleRaf2 = 0;
    settleRaf1 = requestAnimationFrame(() => {
      settleRaf1 = 0;
      settleRaf2 = requestAnimationFrame(() => {
        settleRaf2 = 0;
        syncTerminalMetrics();
      });
    });

    // WebSocket. In gated mode (``window.__HERMES_AUTH_REQUIRED__``) this
    // awaits a single-use ticket via /api/auth/ws-ticket before opening;
    // in loopback mode it resolves synchronously against the injected
    // session token. The IIFE keeps the outer effect synchronous so its
    // ``return cleanup`` stays at the top level; handlers + disposables
    // are hoisted to ``let`` bindings the cleanup closes over.
    let unmounting = false;
    let effectSocket: WebSocket | null = null;
    let onDataDisposable: { dispose(): void } | null = null;
    let onResizeDisposable: { dispose(): void } | null = null;
    const forceFresh = forceFreshPtyRef.current;
    forceFreshPtyRef.current = false;
    // A connect attempt is now in flight — set synchronously (before the async
    // socket-open IIFE below awaits its ticket URL) so a page-resume event in
    // that gap doesn't fire a redundant reconnect (wsRef isn't assigned yet).
    connectInFlightRef.current = true;
    const clearConnectingTimer = () => {
      if (connectingTimerRef.current) {
        clearTimeout(connectingTimerRef.current);
        connectingTimerRef.current = null;
      }
    };
    const scheduleReconnect = (code: number) => {
      if (reconnectTimerRef.current) {
        return;
      }
      const attempt = Math.min(reconnectAttemptRef.current + 1, 5);
      reconnectAttemptRef.current = attempt;
      const delayMs = Math.min(250 * 2 ** (attempt - 1), 3000);
      setBanner(null);
      setLastCloseCode(code);
      setPtyState("reconnecting");
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        setReconnectNonce((n) => n + 1);
      }, delayMs);
    };
    void (async () => {
      if (unmounting) return;
      const params: Record<string, string> = { channel };
      if (resumeParam) params.resume = resumeParam;
      if (forceFresh) params.fresh = "1";
      // Keep-alive identity and semantic event channel rotate together before
      // a forced-fresh render; reconnects reuse both values unchanged.
      params.attach = ptyAttachIdentity;
      // Profile-scoped chat: the PTY child gets HERMES_HOME pointed at the
      // selected profile, so the conversation runs with that profile's model,
      // skills, memory, and sessions (see web_server._resolve_chat_argv).
      if (scopedProfile) params.profile = scopedProfile;
      let ws: WebSocket | null;
      try {
        ws = await createCurrentPtySocket(
          () => api.buildWsUrl("/api/pty", params),
          (url) => new WebSocket(url),
          () => !unmounting,
        );
      } catch (error) {
        if (!unmounting) {
          connectInFlightRef.current = false;
          setPtyState("closed");
          setBanner(
            error instanceof Error
              ? `Chat websocket unavailable: ${error.message}`
              : "Chat websocket unavailable.",
          );
        }
        return;
      }
      if (!ws) return;
      effectSocket = ws;
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      // W2 (NS-591): a mobile socket can wedge in CONNECTING after a radio
      // handoff and never fire onclose, so neither the resume predicate nor
      // scheduleReconnect can recover it. Force-close if it hasn't opened
      // within the budget; the resulting onclose routes into scheduleReconnect.
      clearConnectingTimer();
      connectingTimerRef.current = setTimeout(() => {
        connectingTimerRef.current = null;
        if (wsRef.current === ws && ws.readyState === WebSocket.CONNECTING) {
          try {
            ws.close();
          } catch {
            /* already tearing down */
          }
        }
      }, PTY_CONNECTING_TIMEOUT_MS);

    ws.onopen = () => {
      if (unmounting || wsRef.current !== ws) {
        try {
          ws.close();
        } catch {
          /* obsolete socket */
        }
        return;
      }
      clearReconnectTimer();
      clearConnectingTimer();
      connectInFlightRef.current = false;
      reconnectAttemptRef.current = 0;
      setBanner(null);
      setLastCloseCode(null);
      setPtyState("open");
      blockedInputNoticeRef.current = false;
      // Connected — cancel any pending reconnect from a prior transient drop.
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      // Send the initial RESIZE immediately so Ink has *a* size to lay
      // out against on its first paint.  The double-rAF block above will
      // follow up with the authoritative measurement — at worst Ink
      // reflows once after the PTY boots, which is imperceptible.
      ws.send(`\x1b[RESIZE:${term.cols};${term.rows}]`);
      // One-shot: a ?learn=<text> param (set by the Skills page "Learn a
      // skill" panel) is typed into the composer as a /learn command once the
      // PTY is up. /learn resolves via command.dispatch → a normal agent turn,
      // so this reuses the existing composer path — no special PTY protocol.
      const learnSeed = searchParams.get("learn");
      if (learnSeed) {
        const next = new URLSearchParams(searchParams);
        next.delete("learn");
        setSearchParams(next, { replace: true });
        const cmd = `/learn ${learnSeed}`.trim();
        // Delay so Ink's composer has mounted and grabbed focus before input.
        setTimeout(() => {
          try {
            wsRef.current?.send(cmd + "\r");
          } catch {
            /* PTY not ready / closed — user can retype */
          }
        }, 800);
      }
    };

    ws.onmessage = (ev) => {
      if (unmounting || wsRef.current !== ws) return;
      if (typeof ev.data === "string") {
        term.write(ev.data);
      } else {
        term.write(new Uint8Array(ev.data as ArrayBuffer));
      }
    };

    ws.onclose = (ev) => {
      if (wsRef.current === ws) wsRef.current = null;
      connectInFlightRef.current = false;
      clearConnectingTimer();
      if (unmounting) {
        return;
      }
      // Surface the real cause to the browser console on every close so a
      // "chat won't connect" report can be diagnosed without server access.
      // The server sends a machine-parseable reason on every rejection (see
      // pty_ws in web_server.py); echo it verbatim alongside the close code.
      const why = ev.reason ? ` reason=${ev.reason}` : "";
      console.warn(`[chat] PTY WebSocket closed code=${ev.code}${why}`);
      setLastCloseCode(ev.code);
      if (ev.code === 4401) {
        setPtyState("closed");
        setBanner(
          ev.reason
            ? `Auth failed (${ev.reason}). Reload to refresh the session.`
            : "Auth failed. Reload the page to refresh the session token.",
        );
        return;
      }
      if (ev.code === 4403) {
        // Host/Origin mismatch (DNS-rebinding guard).
        setPtyState("closed");
        setBanner(
          ev.reason
            ? `Refused: ${ev.reason}.`
            : "Refused: request host/origin doesn't match the dashboard.",
        );
        return;
      }
      if (ev.code === 4404) {
        setPtyState("closed");
        setBanner(
          ev.reason
            ? `Chat websocket unavailable: ${ev.reason}.`
            : "Chat websocket unavailable on this server.",
        );
        return;
      }
      if (ev.code === 4408) {
        setPtyState("closed");
        setBanner(
          ev.reason
            ? `Refused: ${ev.reason}.`
            : "Refused: your client isn't permitted (server bound to localhost only).",
        );
        return;
      }
      if (ev.code === 1011) {
        // Server already wrote an ANSI error frame.
        setPtyState("closed");
        return;
      }
      // Keep-alive close-code contract (web_server.pty_ws + pty_session):
      //   4410 = the agent PROCESS exited (real end) → restart affordance.
      //   4409 = superseded by a newer tab attaching the same token → stay quiet.
      if (ev.code === 4410) {
        term.write(`\r\n\x1b[90m[session ended]\x1b[0m\r\n`);
        setPtyState("ended");
        return;
      }
      if (ev.code === 4409) {
        setPtyState("closed");
        return;
      }
      if (!ev.wasClean || ev.code === 1001 || ev.code === 1006) {
        // Transient transport drop (refresh, sleep/wake, signal loss).
        // Reconnect with backoff; the same ?attach= token reattaches to
        // the still-living PTY, so the conversation continues in place.
        scheduleReconnect(ev.code);
        return;
      }
      // Normal/clean exit: the agent process ended (e.g. the user typed
      // `/exit`, or started a new session). NS-504: surface an explicit
      // restart affordance instead of leaving a dead terminal that only a
      // full page refresh could recover.
      term.write(
        `\r\n\x1b[90m[session ended (code ${ev.code})]\x1b[0m\r\n`,
      );
      setPtyState("ended");
    };

    // Keystrokes → PTY.
    //
    // IMPORTANT:
    // The embedded web chat has occasionally surfaced stray letters/digits
    // in the input line after a turn completes. The most likely culprit is
    // browser-side terminal control traffic being forwarded back into the
    // PTY as if it were user text. SGR mouse tracking is the highest-risk
    // path here: xterm.js emits raw CSI reports (`\x1b[<...`) that look like
    // ordinary bytes to the backend.
    //
    // For the browser embed we prefer input stability over terminal-style
    // mouse reporting, so we drop SGR mouse reports entirely instead of
    // forwarding them into Imperator. Keyboard input, paste, and resize still
    // behave normally.
      // eslint-disable-next-line no-control-regex -- intentional ESC byte in xterm SGR mouse report parser
      const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
      onDataDisposable = term.onData((data) => {
        // Mouse reports (scroll wheel etc.) are not typed input — swallow
        // them before the blocked-input check so scrolling a disconnected
        // terminal doesn't trip the "reconnecting" notice.
        if (SGR_MOUSE_RE.test(data)) {
          return;
        }

        if (
          ws.readyState !== WebSocket.OPEN ||
          shouldBlockPtyInput(ptyStateRef.current)
        ) {
          if (!blockedInputNoticeRef.current) {
            blockedInputNoticeRef.current = true;
            term.write(
              `\r\n\x1b[33m[${PTY_RECONNECT_INPUT_MESSAGE}]\x1b[0m\r\n`,
            );
          }
          return;
        }

        const normalized = normalizePtyMobileInput(
          data,
          ptyInputLineRef.current,
          Date.now() <= mobileReplacementInputUntilRef.current,
        );
        ptyInputLineRef.current = normalized.nextLine;
        if (normalized.normalized) {
          mobileReplacementInputUntilRef.current = 0;
        }
        ws.send(normalized.data);
      });

      onResizeDisposable = term.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(`\x1b[RESIZE:${cols};${rows}]`);
        }
      });
    })();

    // The semantic composer owns focus by default. The terminal only receives
    // focus when the user explicitly opens the lossless raw-console fallback.

    return () => {
      unmounting = true;
      imageUploadDisposed = true;
      imageAttachRef.current = () => undefined;
      syncMetricsRef.current = null;
      onDataDisposable?.dispose();
      onResizeDisposable?.dispose();
      mobileInputCleanup?.();
      host.removeEventListener("paste", handleBrowserPaste, true);
      host.removeEventListener("dragover", handleBrowserDragOver, true);
      host.removeEventListener("drop", handleBrowserDrop, true);
      if (metricsDebounce) clearTimeout(metricsDebounce);
      window.removeEventListener("resize", scheduleSyncTerminalMetrics);
      window.visualViewport?.removeEventListener(
        "resize",
        scheduleSyncTerminalMetrics,
      );
      ro.disconnect();
      if (hostSyncRaf) cancelAnimationFrame(hostSyncRaf);
      if (settleRaf1) cancelAnimationFrame(settleRaf1);
      if (settleRaf2) cancelAnimationFrame(settleRaf2);
      clearReconnectTimer();
      clearConnectingTimer();
      connectInFlightRef.current = false;
      // Close only the socket created by this effect. A later effect may have
      // already installed its own socket in wsRef while this cleanup runs.
      try {
        effectSocket?.close();
      } catch {
        /* already closed */
      }
      if (wsRef.current === effectSocket) {
        wsRef.current = null;
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      copyResetTokenRef.current += 1;
    };
  }, [
    channel,
    clearReconnectTimer,
    resumeParam,
    scopedProfile,
    reconnectNonce,
    ptyAttachIdentity,
    eventSocketReady,
  ]);

  // Refit the off-screen terminal on tab activation. Only return focus to
  // xterm when the user explicitly opened the raw console; the chat composer
  // remains the default interactive surface.
  useEffect(() => {
    if (!isActive) return;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf1 = 0;
      raf2 = requestAnimationFrame(() => {
        raf2 = 0;
        syncMetricsRef.current?.();
        if (rawConsoleOpen) termRef.current?.focus();
      });
    });
    return () => {
      if (raf1) cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [isActive, rawConsoleOpen]);

  const maybeReconnectOnPageResume = useCallback(() => {
    const visibilityState =
      typeof document !== "undefined" ? document.visibilityState : "visible";
    const online =
      typeof navigator === "undefined" ? true : navigator.onLine !== false;
    const socketReadyState = wsRef.current?.readyState ?? null;

    if (banner && ptyStateRef.current === "closed") {
      return;
    }

    if (
      shouldReconnectPtyOnPageResume({
        isActive,
        visibilityState,
        online,
        socketReadyState,
        ptyState: ptyStateRef.current,
        connectInFlight: connectInFlightRef.current,
      })
    ) {
      const now = Date.now();
      if (now - lastResumeReconnectAtRef.current < PTY_RESUME_RECONNECT_THROTTLE_MS) {
        return;
      }
      lastResumeReconnectAtRef.current = now;
      reconnectPty();
    }
  }, [banner, isActive, reconnectPty]);

  useEffect(() => {
    if (!isActive || typeof window === "undefined") {
      return;
    }

    const onResume = () => maybeReconnectOnPageResume();

    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("pageshow", onResume);
    window.addEventListener("focus", onResume);
    window.addEventListener("online", onResume);

    return () => {
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("pageshow", onResume);
      window.removeEventListener("focus", onResume);
      window.removeEventListener("online", onResume);
    };
  }, [isActive, maybeReconnectOnPageResume]);

  // Keep the live xterm theme in sync when the active theme's terminal
  // colors change (e.g. user switches to a custom YAML theme mid-session).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = terminalTheme;
  }, [terminalTheme]);

  // Layout:
  //   outer flex column — sits inside the dashboard's content area
  //   row split — terminal pane (flex-1) + sidebar (fixed width, lg+)
  //   terminal wrapper — rounded, dark, padded — the "terminal window"
  //   floating copy button — bottom-right corner, transparent with a
  //     subtle border; stays out of the way until hovered.  Sends
  //     `/copy\n` to Ink, which emits OSC 52 → our clipboard handler.
  //   sidebar — ChatSidebar opens its own JSON-RPC sidecar; renders
  //     model badge, tool-call list, model picker. Best-effort: if the
  //     sidecar fails to connect the terminal pane keeps working.
  //
  // Mobile model/tools sheet is portaled to `document.body` so it stacks
  // above the app sidebar (`z-50`) and mobile chrome (`z-40`).  The main
  // dashboard column uses `relative z-2`, which traps `position:fixed`
  // descendants below those layers (see Toast.tsx).
  const reconnectBanner =
    ptyState === "reconnecting"
      ? `Chat connection interrupted${
          lastCloseCode ? ` (code ${lastCloseCode})` : ""
        }. Reconnecting...`
      : null;
  const visibleBanner = banner ?? reconnectBanner;
  const showReconnectOverlay =
    ptyState === "reconnecting" || (ptyState === "closed" && !banner);
  const mobileModelToolsPortal =
    isActive &&
    narrow &&
    portalRoot &&
    createPortal(
      <>
        {mobilePanelOpen && (
          <Button
            ghost
            aria-label={t.app.closeModelTools}
            onClick={closeMobilePanel}
            className={cn(
              "fixed inset-0 z-[55] p-0 block",
              "bg-black/60",
            )}
          />
        )}

        <div
          id="chat-side-panel"
          role="complementary"
          aria-label={modelToolsLabel}
          className={cn(
            "font-mondwest fixed top-0 right-0 z-[60] flex h-dvh max-h-dvh w-64 min-w-0 flex-col antialiased",
            "border-l border-current/20 text-midground",
            "bg-background-base/95",
            "transition-transform duration-200 ease-out",
            mobilePanelOpen
              ? "translate-x-0"
              : "pointer-events-none translate-x-full",
          )}
        >
          <div
            className={cn(
              "flex h-14 shrink-0 items-center justify-between gap-2 border-b border-current/20 px-5",
            )}
          >
            <Typography
              mondwest
              className="text-display font-bold text-[1.125rem] leading-[0.95] tracking-[0.0525rem] text-midground"
            >
              {t.app.modelToolsSheetTitle}
              <br />
              {t.app.modelToolsSheetSubtitle}
            </Typography>

            <Button
              ghost
              size="icon"
              onClick={closeMobilePanel}
              aria-label={t.app.closeModelTools}
              className="text-text-secondary hover:text-midground"
            >
              <X />
            </Button>
          </div>

          <div
            className={cn(
              "min-h-0 flex-1 overflow-y-auto overflow-x-hidden",
              "border-t border-current/10",
            )}
          >
            <div className="border-b border-current/10 px-1 py-2">
              <ChatSidebar
                channel={channel}
                profile={scopedProfile}
                onDashboardNewSessionRequest={startFreshDashboardChat}
                onSessionTitleChange={handleSessionTitleChange}
                rawConsoleOpen={rawConsoleOpen}
                onToggleRawConsole={() => setRawConsoleOpen((v) => !v)}
              />
            </div>
            <ChatSessionList
              activeSessionId={resumeParam}
              profile={scopedProfile}
              onPicked={closeMobilePanel}
              onNewChat={startFreshDashboardChat}
            />
          </div>
        </div>
      </>,
      portalRoot,
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <PluginSlot name="chat:top" />
      {mobileModelToolsPortal}

      {visibleBanner && (
        <div className="border border-warning/50 bg-warning/10 text-warning px-3 py-2 text-xs tracking-wide">
          {visibleBanner}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-2 lg:flex-row lg:gap-3">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.28)]">
          <ChatModeTransition
            activeMode={rawConsoleOpen ? "console" : "feed"}
            feed={
              <ChatBubbleFeed
                messages={feedState.messages}
                composer={composer}
                disabled={ptyState !== "open"}
                writeApprovalDisabled={false}
                hydrating={hydrationsInFlight > 0}
                hasOlderHistory={olderHistory.available}
                loadingOlderHistory={olderHistory.loading}
                historyWindowed={olderHistory.windowed}
                onLoadOlderHistory={loadOlderHistory}
                isWorking={agentRunning}
                focusSignal={reconnectNonce}
                onComposerChange={setComposer}
                onSubmit={submitComposer}
                onStop={stopAgent}
                onRetry={retryMessage}
                onApproval={answerApproval}
                onWriteApproval={answerWriteApproval}
                onClarify={answerClarify}
                onImages={(files) => imageAttachRef.current(files)}
              />
            }
            console={
              <div
                className="relative flex min-h-0 flex-1 flex-col overflow-hidden p-2 sm:p-3"
                style={{
                  backgroundColor: terminalBg,
                  boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
                }}
              >
                <div
                  ref={hostRef}
                  className="hermes-chat-xterm-host min-h-0 min-w-0 flex-1"
                />

              <div className="absolute bottom-2 right-2 z-10 flex items-center gap-1.5 sm:bottom-3 sm:right-3 lg:bottom-4 lg:right-4">
                <Button
                  ghost
                  onClick={handleCopyLast}
                  title="Copy last assistant response as raw markdown"
                  aria-label="Copy last assistant response"
                  className={cn(
                    "normal-case tracking-normal font-normal",
                    "rounded border border-current/30 bg-black/20",
                    "opacity-70 hover:opacity-100 hover:border-current/60",
                    "transition-opacity duration-150 px-2 py-1 text-xs sm:px-2.5 sm:py-1.5",
                  )}
                  style={{ color: terminalFg }}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Copy className="h-3 w-3 shrink-0" />
                    <span className="hidden min-[400px]:inline tracking-wide">
                      {copyState === "copied" ? "copied" : "copy last response"}
                    </span>
                  </span>
                </Button>
                <Button
                  ghost
                  onClick={() => setRawConsoleOpen(false)}
                  title="Return to Chat Feed"
                  aria-label="Return to Chat Feed"
                  className={cn(
                    "normal-case tracking-normal font-normal",
                    "rounded border border-current/30 bg-black/20",
                    "opacity-70 hover:opacity-100 hover:border-current/60",
                    "transition-opacity duration-150 px-2 py-1 text-xs sm:px-2.5 sm:py-1.5",
                  )}
                  style={{ color: terminalFg }}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <MessagesSquare className="h-3 w-3 shrink-0" />
                    <span className="hidden min-[400px]:inline tracking-wide">Chat Feed</span>
                  </span>
                </Button>
              </div>
              </div>
            }
          />

          {showReconnectOverlay && (
            <div className="absolute inset-x-3 top-3 z-20 flex justify-center sm:inset-x-auto sm:right-3 sm:justify-end">
              <div className="flex max-w-[min(28rem,calc(100vw-3rem))] flex-col items-start gap-2 border border-warning/60 bg-black/80 px-3 py-2 text-xs text-warning shadow-lg">
                <div className="tracking-wide">
                  {ptyState === "reconnecting"
                    ? "Chat is reconnecting."
                    : "Chat disconnected."}
                </div>
                <Button
                  size="sm"
                  outlined
                  onClick={reconnectPty}
                  prefix={<RotateCcw className="h-4 w-4" />}
                  aria-label="Reconnect chat"
                >
                  Reconnect now
                </Button>
              </div>
            </div>
          )}

          {ptyState === "ended" && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/60">
              <div className="text-sm tracking-wide text-white/80">
                Session ended.
              </div>
              <Button
                onClick={startFreshPty}
                prefix={<RotateCcw className="h-4 w-4" />}
                aria-label="Start a new chat session"
              >
                Start new session
              </Button>
            </div>
          )}
        </div>

        {!narrow && (
          <div
            id="chat-side-panel"
            role="complementary"
            aria-label={modelToolsLabel}
            className="flex min-h-0 shrink-0 flex-col gap-3 overflow-hidden lg:h-full lg:w-60"
          >
            {/* Model picker — keeps the rail thin. */}
            <div className="shrink-0">
              <ChatSidebar
                channel={channel}
                profile={scopedProfile}
                onDashboardNewSessionRequest={startFreshDashboardChat}
                onSessionTitleChange={handleSessionTitleChange}
                rawConsoleOpen={rawConsoleOpen}
                onToggleRawConsole={() => setRawConsoleOpen((v) => !v)}
              />
            </div>

            {/* Session switcher fills the remaining height below the model box. */}
            <div className="min-h-0 flex-1 overflow-hidden">
              <ChatSessionList
                activeSessionId={resumeParam}
                profile={scopedProfile}
                onNewChat={startFreshDashboardChat}
              />
            </div>
          </div>
        )}
      </div>
      <PluginSlot name="chat:bottom" />
    </div>
  );
}

declare global {
  interface Window {
    __HERMES_SESSION_TOKEN__?: string;
    __HERMES_AUTH_REQUIRED__?: boolean;
  }
}
