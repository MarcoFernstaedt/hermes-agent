import { useEffect, useRef, useState } from "react";

import type { DraftEdits } from "@/lib/chat-draft-submit";
import {
  createPushToTalkController,
  type PushToTalkController,
  type SpeechRecognitionPort,
} from "@/lib/speech-push-to-talk";
import type { ChatDraft } from "@/plugins/chat-drafts";
import { CHAT_DRAFT_LIMITS } from "@/plugins/chat-drafts";

interface ChatDraftComposerProps {
  draft: ChatDraft;
  connected: boolean;
  busy: boolean;
  nativeInputState: "empty" | "non-empty" | "unknown";
  onDismiss(): void;
  onInsert(edits: DraftEdits): string | void;
}

type VoiceState = "unavailable" | "idle" | "requesting" | "listening" | "stopping" | "error";

type SpeechRecognitionConstructor = new () => SpeechRecognitionPort;

type SpeechWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

function recognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const speechWindow = window as SpeechWindow;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

export function ChatDraftComposer({
  draft,
  connected,
  busy,
  nativeInputState,
  onDismiss,
  onInsert,
}: ChatDraftComposerProps) {
  const [title, setTitle] = useState(draft.title);
  const [context, setContext] = useState(draft.context);
  const [request, setRequest] = useState("");
  const [status, setStatus] = useState("");
  const [voiceState, setVoiceState] = useState<VoiceState>(() =>
    recognitionConstructor() ? "idle" : "unavailable",
  );
  const pttControllerRef = useRef<PushToTalkController | null>(null);

  const processed = draft.state !== "acknowledged";
  let blockedMessage = "Review the fields, then insert them into the native Chat input. Insertion queues bytes without pressing Enter; PTY acceptance remains unknown.";
  if (draft.state === "inserted-unknown") blockedMessage = "PTY acceptance is unknown. Do not retry automatically. The volatile draft remains visible until you inspect Chat and dismiss it.";
  else if (draft.state === "submitted-unknown") blockedMessage = "Submission acceptance is unknown. Native Enter was queued, but no PTY or provider acknowledgement exists. Inspect Chat; do not retry automatically.";
  else if (draft.state === "failed") blockedMessage = "Enqueue failed. No automatic retry occurred; inspect native Chat before deciding what to do.";
  else if (draft.state === "pending") blockedMessage = "Native Browser Helper acknowledgement is incomplete; insertion remains locked.";
  else if (!connected) blockedMessage = "Reconnect Chat before inserting. The draft remains only in process-local memory.";
  else if (busy) blockedMessage = "Wait for the current turn to finish before inserting browser context.";
  else if (nativeInputState === "unknown") blockedMessage = "Native Chat input state is unknown after cursor or escape input. Explicitly clear it before importing browser context.";
  else if (nativeInputState === "non-empty") blockedMessage = "Native Chat input already contains text. Clear or submit it before inserting browser context.";
  const insertDisabled = processed || !connected || busy || nativeInputState !== "empty";
  const actionLabel = draft.state === "inserted-unknown"
    ? "Insertion status unknown"
    : draft.state === "submitted-unknown"
      ? "Submission status unknown"
      : draft.state === "failed"
        ? "Enqueue failed"
        : processed
          ? "Already processed"
          : "Insert into native Chat input";

  useEffect(() => {
    const stopForPrivacyBoundary = () => pttControllerRef.current?.release();
    const stopWhenHidden = () => {
      if (document.hidden) stopForPrivacyBoundary();
    };
    window.addEventListener("blur", stopForPrivacyBoundary);
    document.addEventListener("visibilitychange", stopWhenHidden);
    return () => {
      window.removeEventListener("blur", stopForPrivacyBoundary);
      document.removeEventListener("visibilitychange", stopWhenHidden);
      pttControllerRef.current?.cancel();
      pttControllerRef.current = null;
    };
  }, []);

  const startPushToTalk = () => {
    if (voiceState === "unavailable") return;
    if (!pttControllerRef.current) {
      const Constructor = recognitionConstructor();
      if (!Constructor) {
        setVoiceState("unavailable");
        return;
      }
      pttControllerRef.current = createPushToTalkController(
        () => new Constructor(),
        {
          language: document.documentElement.lang || navigator.language || "en-US",
          onState: setVoiceState,
          onStatus: setStatus,
          onText: (text) => setRequest((current) => [current.trim(), text].filter(Boolean).join(" ")),
        },
      );
    }
    pttControllerRef.current.press();
  };

  const stopPushToTalk = () => {
    pttControllerRef.current?.release();
  };

  const insert = () => {
    if (insertDisabled) return;
    try {
      const result = onInsert({ title, context, request });
      setStatus(result || "Draft bytes were queued without Enter. PTY acceptance is unknown; inspect Chat and do not retry automatically.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Native input insertion failed. No automatic retry occurred.");
    }
  };

  return (
    <section
      aria-labelledby={`chat-draft-${draft.id}`}
      className="border border-warning/60 bg-warning/5 p-3 text-sm forced-colors:border-[CanvasText]"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-bold text-warning">Untrusted website material</p>
          <h2 id={`chat-draft-${draft.id}`} className="font-bold">Review browser context</h2>
          <p className="text-text-secondary">
            This draft is held only in process-local memory, expires automatically, and is never submitted merely by opening or inserting it.
          </p>
          <p className="text-text-secondary">
            After you use native Send, Hermes and the configured model provider process the message, and it follows normal conversation retention settings.
          </p>
        </div>
        <a href={draft.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">Open sanitized source in new tab</a>
      </div>

      {(draft.sourceUrlRedacted || draft.queryDataPresent) && (
        <div className="mt-2 text-text-secondary" role="note">
          {draft.sourceUrlRedacted && <p>Sensitive query fields or the private fragment were removed before handoff.</p>}
          {draft.queryDataPresent && <p>Some non-credential query data remains in the sanitized source URL; review it as untrusted data.</p>}
        </div>
      )}

      <div className="mt-3 grid gap-3">
        <label className="grid gap-1">
          <span>Reviewed title</span>
          <input maxLength={CHAT_DRAFT_LIMITS.maxTitle} className="min-h-11 border border-current/30 bg-transparent px-2" value={title} disabled={processed} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="grid gap-1">
          <span>Reviewed website material</span>
          <textarea maxLength={CHAT_DRAFT_LIMITS.maxContext} rows={5} className="min-h-28 border border-current/30 bg-transparent p-2" value={context} disabled={processed} onChange={(event) => setContext(event.target.value)} />
        </label>
        <label className="grid gap-1">
          <span>What should Hermes do with this context?</span>
          <textarea maxLength={CHAT_DRAFT_LIMITS.maxRequest} rows={3} className="min-h-20 border border-current/30 bg-transparent p-2" value={request} disabled={processed} onChange={(event) => setRequest(event.target.value)} />
        </label>
        <div>
          <button
            type="button"
            className="min-h-11 border border-current px-3 disabled:opacity-50"
            disabled={voiceState === "unavailable" || processed}
            aria-pressed={voiceState === "requesting" || voiceState === "listening" || voiceState === "stopping"}
            onPointerDown={startPushToTalk}
            onPointerUp={stopPushToTalk}
            onPointerCancel={stopPushToTalk}
            onPointerLeave={stopPushToTalk}
            onBlur={stopPushToTalk}
            onKeyDown={(event) => {
              if ((event.key === " " || event.key === "Enter") && !event.repeat) {
                event.preventDefault();
                startPushToTalk();
              }
            }}
            onKeyUp={(event) => {
              if (event.key === " " || event.key === "Enter") {
                event.preventDefault();
                stopPushToTalk();
              }
            }}
          >
            {voiceState === "listening" || voiceState === "requesting" ? "Listening — release to stop" : "Push to talk"}
          </button>
          <p className="mt-1 text-text-secondary">
            Audio is handled by the browser speech service only while held and is not stored by Hermes. Browser/provider privacy terms apply.
          </p>
          {voiceState === "unavailable" && <p className="mt-1 text-text-secondary">Speech recognition unavailable. You can still type the request.</p>}
        </div>
      </div>

      <p role="status" aria-live="polite" aria-atomic="true" className="mt-2 text-text-secondary">{status || blockedMessage}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="min-h-11 border border-current px-3" onClick={onDismiss}>{processed ? "Confirm and dismiss retained draft" : "Discard browser context"}</button>
        <button type="button" disabled={insertDisabled} className="min-h-11 border border-current bg-current px-3 disabled:opacity-50" onClick={insert}>
          <span className="text-background-base">{actionLabel}</span>
        </button>
      </div>
    </section>
  );
}
