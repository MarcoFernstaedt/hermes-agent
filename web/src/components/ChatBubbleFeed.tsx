import { Button } from "@nous-research/ui/ui/components/button";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Copy,
  LoaderCircle,
  Paperclip,
  RotateCcw,
  SendHorizontal,
  Square,
  TerminalSquare,
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
import { ChatEmptyState } from "@/components/ChatEmptyState";
import { Markdown } from "@/components/Markdown";
import { getChatWelcome, type ChatFeedMessage } from "@/lib/chat-feed-model";
import { GatewayClient } from "@/lib/gatewayClient";
import { cn } from "@/lib/utils";

interface ChatBubbleFeedProps {
  messages: ChatFeedMessage[];
  composer: string;
  disabled?: boolean;
  isWorking: boolean;
  rawConsoleOpen: boolean;
  focusSignal: number;
  onComposerChange(value: string): void;
  onSubmit(): void;
  onStop(): void;
  onRetry(message: ChatFeedMessage): void;
  onApproval(
    choice: "once" | "session" | "always" | "deny",
    message: ChatFeedMessage,
  ): void;
  onClarify(answer: string, message: ChatFeedMessage): void;
  onImages(files: File[]): void;
  onToggleRawConsole(): void;
}

const roleLabel = (message: ChatFeedMessage): string => {
  if (message.role === "user") return "You";
  if (message.role === "assistant") return "Imperator";
  if (message.role === "approval") return "Approval required";
  if (message.role === "clarify") return "Input requested";
  return message.title || message.role;
};

function statusLabel(message: ChatFeedMessage): string | null {
  if (message.status === "sending") return "Sending";
  if (message.status === "streaming") return "Responding";
  if (message.status === "running") return "Running";
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
        message.status === "error" ? "text-destructive" : "text-text-tertiary",
      )}
      aria-label={label}
    >
      {message.status === "sending" ||
      message.status === "streaming" ||
      message.status === "running" ? (
        <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
      ) : message.status === "error" ? (
        <AlertCircle className="size-3" />
      ) : null}
      {label}
    </span>
  );
}

export function ChatBubbleFeed({
  messages,
  composer,
  disabled = false,
  isWorking,
  rawConsoleOpen,
  focusSignal,
  onComposerChange,
  onSubmit,
  onStop,
  onRetry,
  onApproval,
  onClarify,
  onImages,
  onToggleRawConsole,
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

  useEffect(() => {
    void slashGateway.connect().catch(() => undefined);
    return () => slashGateway.close();
  }, [slashGateway]);

  useEffect(() => {
    if (disabled) return;
    const frame = requestAnimationFrame(() => composerRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [disabled, focusSignal]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (nearBottomRef.current) {
      node.scrollTo({
        top: node.scrollHeight,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
      setUnread(false);
    } else {
      setUnread(true);
    }
  }, [messages]);

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
  }, []);

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

  return (
    <section
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-current/15 bg-background-base/80"
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
        {messages.length === 0 ? (
          <ChatEmptyState greeting={welcome.greeting} prompt={welcome.prompt} />
        ) : (
          // max-w-3xl keeps the transcript at a readable measure on wide
          // screens — the column width ChatGPT/Claude converge on.
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 sm:gap-4">
            {messages.map((message) => {
              const user = message.role === "user";
              const assistant = message.role === "assistant";
              const operational =
                message.role === "tool" || message.role === "system";
              const interactive =
                message.role === "approval" || message.role === "clarify";

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
                      <MessageStatus message={message} />
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
                    </div>
                  </div>
                </article>
              );
            })}
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

      <div className="shrink-0 border-t border-current/15 bg-background-base/95 p-2.5 backdrop-blur sm:p-3 pb-[max(0.625rem,env(safe-area-inset-bottom,0px))] sm:pb-3">
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

          <div className="flex items-end gap-2 rounded-xl border border-current/20 bg-foreground/5 p-2 focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/30">
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
            <textarea
              ref={composerRef}
              value={composer}
              onChange={(event) => onComposerChange(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              rows={1}
              disabled={disabled}
              aria-label="Message Imperator"
              placeholder={disabled ? "Reconnecting…" : "Message Imperator or type / for commands"}
              className="max-h-40 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-2 py-2.5 text-base leading-6 text-foreground outline-none placeholder:text-text-tertiary disabled:cursor-not-allowed sm:text-sm"
            />
            <Button
              size="icon"
              onClick={isWorking && !composer.trim() ? onStop : onSubmit}
              disabled={disabled || (!isWorking && !composer.trim())}
              aria-label={
                isWorking && !composer.trim()
                  ? "Stop agent"
                  : isWorking
                    ? "Send while agent is working"
                    : "Send message"
              }
              title={
                isWorking && !composer.trim()
                  ? "Stop agent"
                  : isWorking
                    ? "Send while agent is working"
                    : "Send message"
              }
              className="mb-0.5 shrink-0"
            >
              {isWorking && !composer.trim() ? (
                <Square className="size-3.5 fill-current" />
              ) : (
                <SendHorizontal className="size-4" />
              )}
            </Button>
          </div>

          <div className="mt-1.5 flex items-center justify-end px-1 text-[0.6875rem] text-text-tertiary">
            <Button
              ghost
              size="sm"
              onClick={onToggleRawConsole}
              aria-expanded={rawConsoleOpen}
              prefix={<TerminalSquare className="size-3" />}
              className="h-7 px-1.5 text-[0.6875rem] normal-case tracking-normal"
            >
              {rawConsoleOpen ? "Hide raw console" : "Raw console"}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
