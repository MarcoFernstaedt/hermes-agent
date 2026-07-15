import { MessagesSquare } from "lucide-react";

interface ChatEmptyStateProps {
  greeting: string;
  prompt: string;
}

export function ChatEmptyState({ greeting, prompt }: ChatEmptyStateProps) {
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
    </div>
  );
}
