import type { DraftEdits } from "@/lib/chat-draft-submit";
import type { ChatDraft } from "@/plugins/chat-drafts";
import { ChatDraftComposer } from "./ChatDraftComposer";

interface ChatDraftInboxProps {
  drafts: ChatDraft[];
  connected: boolean;
  busy: boolean;
  nativeInputState: "empty" | "non-empty" | "unknown";
  onInsert(draft: ChatDraft, edits: DraftEdits): string | void;
  onDismiss(id: string): void;
  onClearAll(): void;
}

export function ChatDraftInbox({
  drafts,
  connected,
  busy,
  nativeInputState,
  onInsert,
  onDismiss,
  onClearAll,
}: ChatDraftInboxProps) {
  const ordered = [...drafts].sort((left, right) =>
    left.createdAt - right.createdAt || left.id.localeCompare(right.id));

  return (
    <section aria-labelledby="browser-context-inbox" className="border-b border-border bg-background-surface px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="browser-context-inbox" className="font-bold">Browser context inbox</h2>
          <p className="text-sm text-text-secondary">
            {ordered.length} volatile drafts · oldest first · process-local memory only. Drafts expire automatically and are never retried automatically.
          </p>
        </div>
        <button
          type="button"
          className="min-h-11 border border-current px-3 disabled:opacity-50"
          disabled={ordered.length === 0}
          onClick={onClearAll}
        >
          Clear all browser context
        </button>
      </div>
      {ordered.length === 0 ? (
        <div role="status" className="mt-2 text-sm text-text-secondary">
          <strong>No reviewed browser context is available.</strong>
          <p>Import and insertion are locked until the authenticated Browser Helper provides a reviewed item.</p>
        </div>
      ) : (
        <ol className="mt-3 grid gap-3">
          {ordered.map((draft) => (
            <li key={draft.id}>
              <details open={ordered.length === 1} className="border border-border">
                <summary className="min-h-11 cursor-pointer px-3 py-2 font-medium">
                  Inspect {draft.title || "untitled reviewed context"} · {draft.state.replace(/-/g, " ")}
                </summary>
                <ChatDraftComposer
                  draft={draft}
                  connected={connected}
                  busy={busy}
                  nativeInputState={nativeInputState}
                  onInsert={(edits) => onInsert(draft, edits)}
                  onDismiss={() => onDismiss(draft.id)}
                />
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
