import { MessagesSquare } from "lucide-react";

interface ChatEmptyStateProps {
  greeting: string;
  prompt: string;
  /** Optional quick-start prompts rendered as tappable chips. */
  suggestions?: string[];
  onSuggestion?(prompt: string): void;
}

export function ChatEmptyState({
  greeting,
  prompt,
  suggestions,
  onSuggestion,
}: ChatEmptyStateProps) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 text-center text-text-tertiary">
      <div
        role="img"
        aria-label="Start a new chat"
        className="rounded-full border border-primary/30 bg-primary/10 p-3 text-primary"
      >
        <MessagesSquare className="size-5" aria-hidden="true" />
      </div>
      <p className="text-sm font-medium text-text-secondary">{greeting}</p>
      <p className="max-w-sm text-xs">{prompt}</p>

      {suggestions && suggestions.length > 0 && onSuggestion && (
        <div className="mt-3 flex max-w-md flex-wrap items-center justify-center gap-2">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => onSuggestion(suggestion)}
              className={
                "min-h-9 cursor-pointer rounded-full border border-current/20 px-3.5 py-1.5 " +
                "text-xs text-text-secondary transition-colors " +
                "hover:border-primary/50 hover:text-midground " +
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground"
              }
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
