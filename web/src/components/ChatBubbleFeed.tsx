import { Button } from "@nous-research/ui/ui/components/button";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Copy,
  ListPlus,
  LoaderCircle,
  Mic,
  Paperclip,
  RotateCcw,
  SendHorizontal,
  Square,
  Volume2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import {
  SlashPopover,
  type SlashPopoverHandle,
} from "@/components/SlashPopover";
import { AgentLiveStatus } from "@/components/AgentLiveStatus";
import { ChatEmptyState } from "@/components/ChatEmptyState";
import { Markdown } from "@/components/Markdown";
import { api } from "@/lib/api";
import { useAppSettings } from "@/lib/app-settings";
import { useDictation } from "@/lib/use-dictation";
import { formatMessageTime } from "@/lib/format";
import { getChatWelcome, type ChatFeedMessage } from "@/lib/chat-feed-model";
import { GatewayClient } from "@/lib/gatewayClient";
import { cn } from "@/lib/utils";

interface ChatBubbleFeedProps {
  messages: ChatFeedMessage[];
  composer: string;
  disabled?: boolean;
  writeApprovalDisabled?: boolean;
  /** A selected session's history is being fetched into the feed. */
  hydrating?: boolean;
  /** Older messages exist beyond the loaded window. */
  hasOlderHistory?: boolean;
  /** An older page is being fetched right now. */
  loadingOlderHistory?: boolean;
  /** A history window has loaded (gates the beginning-of-session marker). */
  historyWindowed?: boolean;
  onLoadOlderHistory?(): void;
  isWorking: boolean;
  focusSignal: number;
  onComposerChange(value: string): void;
  onSubmit(): void;
  onStop(): void;
  onRetry(message: ChatFeedMessage): void;
  onApproval(
    choice: "once" | "session" | "always" | "deny",
    message: ChatFeedMessage,
  ): void;
  onWriteApproval(choice: "approve" | "reject", message: ChatFeedMessage): void;
  onClarify(answer: string, message: ChatFeedMessage): void;
  onImages(files: File[]): void;
}

const roleLabel = (message: ChatFeedMessage): string => {
  if (message.role === "user") return "You";
  if (message.role === "assistant") return "Imperator";
  if (message.role === "approval") return "Approval required";
  if (message.role === "write_approval") return "Change approval required";
  if (message.role === "clarify") return "Input requested";
  return message.title || message.role;
};

function MessageTime({ message }: { message: ChatFeedMessage }) {
  const label = formatMessageTime(message.timestamp);
  if (!label) return null;
  return (
    <time
      dateTime={new Date(
        message.timestamp < 10_000_000_000
          ? message.timestamp * 1000
          : message.timestamp,
      ).toISOString()}
      className="shrink-0 text-xs tracking-wide text-text-tertiary"
    >
      {label}
    </time>
  );
}

function statusLabel(message: ChatFeedMessage): string | null {
  if (message.status === "sending") return "Sending";
  if (message.status === "streaming") return "Responding";
  if (message.status === "running") return "Running";
  if (message.status === "queued") return "Queued";
  if (message.status === "waiting") {
    return message.role === "user" ? "Waiting to send" : "Waiting for you";
  }
  if (message.status === "error") return "Failed";
  return null;
}

function MessageStatus({ message }: { message: ChatFeedMessage }) {
  const label = statusLabel(message);
  if (!label) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[0.6875rem] tracking-wide",
        message.status === "error"
          ? "text-destructive"
          : message.status === "queued"
            ? "text-midground"
            : "text-text-tertiary",
      )}
      aria-label={label}
    >
      {message.status === "sending" ||
      message.status === "streaming" ||
      message.status === "running" ? (
        <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
      ) : message.status === "queued" ? (
        <ListPlus className="size-3 animate-[queued-pulse_1.6s_ease-in-out_infinite] motion-reduce:animate-none" />
      ) : message.status === "error" ? (
        <AlertCircle className="size-3" />
      ) : null}
      {label}
    </span>
  );
}

/** Alive "agent is working" cue shown in the feed between your message and the
 *  first streamed token: three gold dots bobbing. Disabled under reduced
 *  motion, where it becomes a plain static "working" line. */
function ThinkingRow() {
  return (
    <div className="flex items-center gap-2 px-1 py-1" role="status" aria-label="Imperator is working">
      <span className="flex items-center gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 rounded-full bg-midground animate-[thinking-bob_1.2s_ease-in-out_infinite] motion-reduce:animate-none"
            style={{ animationDelay: `${i * 160}ms` }}
          />
        ))}
      </span>
      <span className="text-xs text-text-tertiary">Imperator is working…</span>
    </div>
  );
}

export function ChatBubbleFeed({
  messages,
  composer,
  disabled = false,
  writeApprovalDisabled = disabled,
  hydrating = false,
  hasOlderHistory = false,
  loadingOlderHistory = false,
  historyWindowed = false,
  onLoadOlderHistory,
  isWorking,
  focusSignal,
  onComposerChange,
  onSubmit,
  onStop,
  onRetry,
  onApproval,
  onWriteApproval,
  onClarify,
  onImages,
}: ChatBubbleFeedProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const slashRef = useRef<SlashPopoverHandle | null>(null);
  const nearBottomRef = useRef(true);
  const [unread, setUnread] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const slashGateway = useMemo(() => new GatewayClient(), []);
  const welcome = useMemo(() => getChatWelcome(), []);
  // Mirrors chat-send-queue's rule: plain messages queue while the agent
  // runs; slash commands always send immediately.
  const willQueue =
    isWorking &&
    composer.trim().length > 0 &&
    !composer.trimStart().startsWith("/");
  const { showToolCalls, showTimestamps } = useAppSettings();

  // Voice dictation → composer. A ref keeps the callback reading the latest
  // draft so a transcript appends instead of clobbering typed text.
  const composerValueRef = useRef(composer);
  useEffect(() => {
    composerValueRef.current = composer;
  }, [composer]);
  const dictation = useDictation((text) => {
    const current = composerValueRef.current;
    onComposerChange(current.trim() ? `${current.trimEnd()} ${text}` : text);
    requestAnimationFrame(() => composerRef.current?.focus());
  });

  // "Show tool activity" (chat panel setting) hides operational rows only —
  // conversation, approvals, and clarifications always render.
  const visibleMessages = useMemo(
    () =>
      showToolCalls
        ? messages
        : messages.filter(
            (message) =>
              message.role !== "tool" && message.role !== "system",
          ),
    [messages, showToolCalls],
  );

  useEffect(() => {
    void slashGateway.connect().catch(() => undefined);
    return () => slashGateway.close();
  }, [slashGateway]);

  useEffect(() => {
    if (disabled) return;
    const frame = requestAnimationFrame(() => composerRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [disabled, focusSignal]);

  // Scroll anchoring for older-page prepends: capture the geometry when a
  // load is requested; after the rows land, restore the visual position so
  // the transcript doesn't jump under the user's thumb.
  const prependAnchorRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);

  const requestOlderHistory = useCallback(() => {
    if (!onLoadOlderHistory || !hasOlderHistory || loadingOlderHistory) return;
    const node = scrollRef.current;
    if (node) {
      prependAnchorRef.current = {
        scrollHeight: node.scrollHeight,
        scrollTop: node.scrollTop,
      };
    }
    onLoadOlderHistory();
  }, [onLoadOlderHistory, hasOlderHistory, loadingOlderHistory]);

  const prevMessageCountRef = useRef(0);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const previousCount = prevMessageCountRef.current;
    prevMessageCountRef.current = visibleMessages.length;

    const anchor = prependAnchorRef.current;
    if (anchor && !loadingOlderHistory && visibleMessages.length > previousCount) {
      // Older rows just prepended above the viewport — keep what the user
      // was reading exactly where it was.
      prependAnchorRef.current = null;
      node.scrollTop = node.scrollHeight - anchor.scrollHeight + anchor.scrollTop;
      return;
    }

    if (previousCount === 0 && visibleMessages.length > 0) {
      // A session just hydrated: land near the latest exchange instantly,
      // then glide the final stretch — the transcript arrives at the newest
      // message instead of opening at the top of the history.
      node.scrollTop = Math.max(
        0,
        node.scrollHeight - node.clientHeight * 2,
      );
      requestAnimationFrame(() => {
        node.scrollTo({
          top: node.scrollHeight,
          behavior: reducedMotion ? "auto" : "smooth",
        });
      });
      nearBottomRef.current = true;
      setUnread(false);
      return;
    }

    if (nearBottomRef.current) {
      node.scrollTo({
        top: node.scrollHeight,
        behavior: reducedMotion ? "auto" : "smooth",
      });
      setUnread(false);
    } else {
      setUnread(true);
    }
  }, [visibleMessages, loadingOlderHistory]);

  useEffect(() => {
    const textarea = composerRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [composer]);

  const onScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 96;
    nearBottomRef.current = nearBottom;
    if (nearBottom) setUnread(false);
    // Approaching the top pulls the next older page in automatically —
    // the button stays as an explicit affordance.
    if (node.scrollTop < 80) requestOlderHistory();
  }, [requestOlderHistory]);

  const jumpToLatest = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    nearBottomRef.current = true;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    setUnread(false);
  }, []);

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashRef.current?.handleKey(event)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  };

  const copy = useCallback((message: ChatFeedMessage) => {
    void navigator.clipboard.writeText(message.text).then(() => {
      setCopiedId(message.id);
      window.setTimeout(() => setCopiedId(null), 1500);
    });
  }, []);

  // Opt-in text-to-speech playback of an assistant reply. Manual only — never
  // auto-plays, so it can't fight a screen reader. One clip plays at a time.
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const speak = useCallback(async (message: ChatFeedMessage) => {
    ttsAudioRef.current?.pause();
    if (speakingId === message.id) {
      setSpeakingId(null);
      return;
    }
    setSpeakingId(message.id);
    try {
      const res = await api.speakText(message.text);
      const audio = new Audio(res.data_url);
      ttsAudioRef.current = audio;
      audio.onended = () => setSpeakingId((id) => (id === message.id ? null : id));
      audio.onerror = () => setSpeakingId((id) => (id === message.id ? null : id));
      await audio.play();
    } catch {
      setSpeakingId((id) => (id === message.id ? null : id));
    }
  }, [speakingId]);

  return (
    <section
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden border-0 bg-background-base/80 lg:rounded-lg lg:border lg:border-current/15"
      aria-label="Chat conversation"
      onPaste={(event) => {
        const files = Array.from(event.clipboardData.files).filter((file) =>
          file.type.startsWith("image/"),
        );
        if (!files.length) return;
        event.preventDefault();
        onImages(files);
      }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.items).some((item) => item.type.startsWith("image/"))) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        const files = Array.from(event.dataTransfer.files).filter((file) =>
          file.type.startsWith("image/"),
        );
        if (!files.length) return;
        event.preventDefault();
        onImages(files);
      }}
    >
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-5 sm:py-5"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {visibleMessages.length === 0 && hydrating ? (
          <div
            className="flex h-full min-h-40 flex-col items-center justify-center gap-3 text-text-tertiary"
            aria-busy="true"
            aria-live="polite"
          >
            <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" />
            <p className="text-sm text-text-secondary">Loading conversation…</p>
          </div>
        ) : visibleMessages.length === 0 ? (
          <ChatEmptyState
            greeting={welcome.greeting}
            prompt={welcome.prompt}
            suggestions={[
              "What can you do for me?",
              "Give me a status report",
              "Help me plan my day",
            ]}
            onSuggestion={(suggestion) => {
              onComposerChange(suggestion);
              requestAnimationFrame(() => composerRef.current?.focus());
            }}
          />
        ) : (
          // max-w-3xl keeps the transcript at a readable measure on wide
          // screens — the column width ChatGPT/Claude converge on.
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 sm:gap-4">
            {historyWindowed && (
              loadingOlderHistory ? (
                <div
                  className="flex items-center justify-center gap-2 py-2 text-xs text-text-tertiary"
                  aria-busy="true"
                  aria-live="polite"
                >
                  <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
                  Loading earlier messages…
                </div>
              ) : hasOlderHistory ? (
                <div className="flex justify-center py-1">
                  <Button size="sm" ghost onClick={requestOlderHistory}>
                    Load earlier messages
                  </Button>
                </div>
              ) : (
                <div
                  className="flex items-center gap-3 py-2 text-xs tracking-wide text-text-tertiary"
                  role="note"
                >
                  <span aria-hidden className="h-px flex-1 bg-current/20" />
                  Beginning of session
                  <span aria-hidden className="h-px flex-1 bg-current/20" />
                </div>
              )
            )}
            {visibleMessages.map((message) => {
              const user = message.role === "user";
              const assistant = message.role === "assistant";
              const operational =
                message.role === "tool" || message.role === "system";
              const interactive =
                message.role === "approval" ||
                message.role === "write_approval" ||
                message.role === "clarify";

              return (
                <article
                  key={message.id}
                  className={cn(
                    "group flex w-full",
                    user ? "justify-end" : "justify-start",
                  )}
                  aria-label={`${roleLabel(message)} message`}
                >
                  <div
                    className={cn(
                      "min-w-0 max-w-[92%] rounded-2xl border px-3.5 py-3 shadow-sm sm:max-w-[82%] sm:px-4",
                      "motion-safe:transition-colors motion-reduce:transition-none",
                      user &&
                        "rounded-br-sm border-primary/35 bg-primary/15 text-foreground",
                      assistant &&
                        "rounded-bl-sm border-current/15 bg-foreground/5 text-foreground",
                      operational &&
                        "max-w-full rounded-lg border-current/15 bg-background-base/70 font-mono text-xs",
                      interactive &&
                        "max-w-full rounded-xl border-warning/45 bg-warning/10",
                      message.status === "error" &&
                        "border-destructive/50 bg-destructive/10",
                      // Alive treatment while a message waits in the agent's
                      // queue: a gentle gold ring breathing until it runs.
                      message.status === "queued" &&
                        "border-midground/50 animate-[queued-glow_2s_ease-in-out_infinite] motion-reduce:animate-none",
                    )}
                  >
                    <div className="mb-1.5 flex min-w-0 items-center justify-between gap-3">
                      <span
                        className={cn(
                          "truncate text-[0.6875rem] font-semibold uppercase tracking-[0.11em]",
                          user
                            ? "text-primary"
                            : interactive
                              ? "text-warning"
                              : "text-text-tertiary",
                        )}
                      >
                        {roleLabel(message)}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <MessageStatus message={message} />
                        {showTimestamps && <MessageTime message={message} />}
                      </span>
                    </div>

                    {operational ? (
                      <details className="group/details" open={message.status === "running"}>
                        <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 text-text-secondary marker:hidden">
                          <ChevronDown className="size-3.5 shrink-0 transition-transform group-open/details:rotate-180 motion-reduce:transition-none" />
                          <span className="truncate">
                            {message.status === "running"
                              ? "Live operational output"
                              : "Operational output"}
                          </span>
                        </summary>
                        <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words border-t border-current/10 pt-2 text-foreground">
                          {message.text || "No textual output"}
                        </pre>
                      </details>
                    ) : assistant ? (
                      // Assistant replies render as markdown (code blocks,
                      // lists, links…) with a streaming caret — the reading
                      // experience users know from ChatGPT/Claude.
                      <div className="min-w-0 break-words">
                        {message.text ? (
                          <Markdown
                            content={message.text}
                            streaming={message.status === "streaming"}
                          />
                        ) : message.status === "streaming" ? (
                          <div className="text-sm leading-relaxed text-text-secondary">
                            Thinking…
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="whitespace-pre-wrap break-words text-sm leading-relaxed sm:text-[0.9375rem]">
                        {message.text ||
                          (message.status === "streaming" ? "Thinking…" : "")}
                      </div>
                    )}

                    {message.role === "approval" && message.status === "waiting" && (
                      <div className="mt-3 flex flex-wrap gap-2 border-t border-warning/25 pt-3">
                        <Button size="sm" onClick={() => onApproval("once", message)}>
                          Allow once
                        </Button>
                        <Button
                          size="sm"
                          outlined
                          onClick={() => onApproval("session", message)}
                        >
                          Allow this session
                        </Button>
                        {message.allowPermanent !== false && (
                          <Button
                            size="sm"
                            outlined
                            onClick={() => onApproval("always", message)}
                          >
                            Always allow
                          </Button>
                        )}
                        <Button
                          size="sm"
                          outlined
                          onClick={() => onApproval("deny", message)}
                          className="text-destructive"
                        >
                          Deny
                        </Button>
                      </div>
                    )}

                    {message.role === "write_approval" &&
                      (message.status === "waiting" || message.status === "running") && (
                        <div className="mt-3 flex flex-wrap gap-2 border-t border-warning/25 pt-3">
                          <Button
                            size="sm"
                            disabled={writeApprovalDisabled || message.status === "running"}
                            onClick={() => onWriteApproval("approve", message)}
                          >
                            {message.status === "running"
                              ? "Submitting decision"
                              : "Approve change"}
                          </Button>
                          <Button
                            size="sm"
                            outlined
                            disabled={writeApprovalDisabled || message.status === "running"}
                            onClick={() => onWriteApproval("reject", message)}
                            className="text-destructive"
                          >
                            Reject change
                          </Button>
                        </div>
                      )}

                    {message.role === "clarify" && message.status === "waiting" && (
                      <div className="mt-3 flex flex-wrap gap-2 border-t border-warning/25 pt-3">
                        {message.choices?.map((choice) => (
                          <Button
                            key={choice}
                            size="sm"
                            outlined
                            onClick={() => onClarify(choice, message)}
                          >
                            {choice}
                          </Button>
                        ))}
                        <Button
                          size="sm"
                          ghost
                          onClick={() => composerRef.current?.focus()}
                        >
                          Type another answer
                        </Button>
                      </div>
                    )}

                    {message.resolution && (
                      <div className="mt-2 flex items-center gap-1 text-xs text-text-tertiary">
                        <Check className="size-3" />
                        {message.resolution}
                      </div>
                    )}

                    <div className="mt-2 flex min-h-5 items-center justify-end gap-1 opacity-70 group-hover:opacity-100 group-focus-within:opacity-100">
                      {message.status === "error" && message.role === "user" && (
                        <Button
                          ghost
                          size="sm"
                          onClick={() => onRetry(message)}
                          prefix={<RotateCcw className="size-3" />}
                        >
                          Retry
                        </Button>
                      )}
                      {message.role === "assistant" && message.text && (
                        <Button
                          ghost
                          size="icon"
                          onClick={() => copy(message)}
                          aria-label="Copy agent message"
                          title="Copy agent message"
                        >
                          {copiedId === message.id ? (
                            <Check className="size-3.5" />
                          ) : (
                            <Copy className="size-3.5" />
                          )}
                        </Button>
                      )}
                      {message.role === "assistant" && message.text && (
                        <Button
                          ghost
                          size="icon"
                          onClick={() => void speak(message)}
                          aria-label={
                            speakingId === message.id
                              ? "Stop playback"
                              : "Play agent message aloud"
                          }
                          aria-pressed={speakingId === message.id}
                          title="Play aloud"
                        >
                          {speakingId === message.id ? (
                            <LoaderCircle className="size-3.5 animate-spin" />
                          ) : (
                            <Volume2 className="size-3.5" />
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
            {isWorking &&
              !(
                visibleMessages[visibleMessages.length - 1]?.role === "assistant" &&
                visibleMessages[visibleMessages.length - 1]?.status === "streaming"
              ) && <ThinkingRow />}
          </div>
        )}
      </div>

      {unread && (
        <Button
          size="sm"
          onClick={jumpToLatest}
          className="absolute bottom-28 left-1/2 z-20 -translate-x-1/2 shadow-lg"
          prefix={<ChevronDown className="size-4" />}
        >
          New messages
        </Button>
      )}

      {/* No top border or filled bar — the composer floats as a rounded card
          on the same flat background as the transcript, so when the software
          keyboard opens/closes the surface reads as one continuous sheet
          (Claude-style) instead of a seam sliding up and down. */}
      <div className="chat-dock-inset shrink-0 px-3 pt-2 sm:px-4">
        <div className="relative mx-auto max-w-3xl">
          <SlashPopover
            ref={slashRef}
            input={composer}
            gw={slashGateway}
            onApply={(value) => {
              onComposerChange(value);
              requestAnimationFrame(() => composerRef.current?.focus());
            }}
          />

          <div className="flex items-end gap-2 rounded-3xl border border-current/15 bg-foreground/[0.07] p-2 shadow-[0_2px_20px_rgba(0,0,0,0.28)] backdrop-blur-sm transition-colors focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/25">
            {/* Explicit attach affordance — paste and drag-drop don't exist
                on touch devices, so the paperclip is the only image path
                on phones. */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              aria-hidden
              tabIndex={-1}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []).filter(
                  (file) => file.type.startsWith("image/"),
                );
                if (files.length) onImages(files);
                event.target.value = "";
              }}
            />
            <Button
              ghost
              size="icon"
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach images"
              title="Attach images"
              className="mb-0.5 shrink-0 text-text-secondary hover:text-foreground"
            >
              <Paperclip className="size-4" />
            </Button>
            {dictation.supported && (
              <Button
                ghost
                size="icon"
                disabled={disabled || dictation.state === "transcribing"}
                onClick={() =>
                  dictation.state === "recording"
                    ? dictation.stop()
                    : void dictation.start()
                }
                aria-label={
                  dictation.state === "recording"
                    ? "Stop dictation"
                    : dictation.state === "transcribing"
                      ? "Transcribing…"
                      : "Dictate a message"
                }
                aria-pressed={dictation.state === "recording"}
                title="Dictate a message"
                className={`mb-0.5 shrink-0 ${
                  dictation.state === "recording"
                    ? "text-destructive"
                    : "text-text-secondary hover:text-foreground"
                }`}
              >
                {dictation.state === "transcribing" ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : dictation.state === "recording" ? (
                  <Square className="size-3.5 animate-pulse fill-current" />
                ) : (
                  <Mic className="size-4" />
                )}
              </Button>
            )}
            <textarea
              ref={composerRef}
              value={composer}
              onChange={(event) => onComposerChange(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              rows={1}
              disabled={disabled}
              aria-label="Message Imperator"
              placeholder={
                disabled
                  ? "Reconnecting…"
                  : isWorking
                    ? "Imperator is working — messages will queue"
                    : "Send Imperator a message"
              }
              className="max-h-40 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-2 py-2.5 text-base leading-6 text-foreground outline-none placeholder:italic placeholder:text-text-disabled disabled:cursor-not-allowed sm:text-sm"
            />
            <Button
              size="icon"
              onClick={isWorking && !composer.trim() ? onStop : onSubmit}
              disabled={disabled || (!isWorking && !composer.trim())}
              aria-label={
                isWorking && !composer.trim()
                  ? "Stop agent"
                  : willQueue
                    ? "Queue message — sends when Imperator finishes"
                    : "Send message"
              }
              title={
                isWorking && !composer.trim()
                  ? "Stop agent"
                  : willQueue
                    ? "Queue message — sends when Imperator finishes"
                    : "Send message"
              }
              className="mb-0.5 shrink-0"
            >
              {isWorking && !composer.trim() ? (
                <Square className="size-3.5 fill-current" />
              ) : willQueue ? (
                // While the agent is mid-run a plain message queues instead
                // of steering — the button says so before the user commits.
                <ListPlus className="size-4" />
              ) : (
                <SendHorizontal className="size-4" />
              )}
            </Button>
          </div>

          <div className="mt-1.5 flex items-center justify-between gap-2 px-1 text-xs text-text-tertiary">
            {/* Always-on agent state: the user can tell at a glance whether
                Imperator is mid-run, idle, or the link is down. This pill is
                visual only — screen-reader announcements come from the
                debounced AgentLiveStatus region below, which avoids the noisy
                re-announcement a role="status" pill produces on every toggle. */}
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  disabled
                    ? "bg-destructive"
                    : isWorking
                      ? "bg-warning animate-pulse motion-reduce:animate-none"
                      : "bg-success",
                )}
              />
              <span className="truncate">
                {disabled
                  ? "Reconnecting…"
                  : isWorking
                    ? "Imperator is working…"
                    : "Idle — ready"}
              </span>
            </span>
            <AgentLiveStatus
              state={disabled ? "reconnecting" : isWorking ? "working" : "idle"}
            />

            {/* Voice dictation feedback — errors announced politely. */}
            <span
              className={cn(
                "truncate text-right",
                dictation.error ? "text-warning" : "text-text-tertiary",
              )}
              aria-live="polite"
            >
              {dictation.error
                ? dictation.error
                : dictation.state === "recording"
                  ? "Listening…"
                  : dictation.state === "transcribing"
                    ? "Transcribing…"
                    : ""}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
