import { useState } from "react";
import { Pencil, Sparkles } from "lucide-react";
import { api } from "@/lib/api";

/**
 * Inline rename affordance beside the chat header title. Click the pencil to
 * edit; Enter commits, Escape reverts, blur commits. Persists via the
 * session patch endpoint and reports the new title so the header updates
 * optimistically. Rolls back on failure.
 *
 * A second affordance regenerates the title from the conversation's first
 * exchange (the same auto-titler the agent runs after the first reply),
 * for when a chat's topic has drifted from its original name.
 */
export function ChatHeaderRename({
  sessionId,
  title,
  profile,
  onRenamed,
}: {
  sessionId: string;
  title: string | null;
  profile?: string;
  onRenamed: (title: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title ?? "");
  const [regenerating, setRegenerating] = useState(false);

  const regenerate = async () => {
    if (regenerating) return;
    setRegenerating(true);
    const previous = title;
    try {
      const res = await api.regenerateSessionTitle(sessionId, profile);
      if (res.title) onRenamed(res.title);
    } catch {
      onRenamed(previous); // no-op restore; keeps the header stable on failure
    } finally {
      setRegenerating(false);
    }
  };

  const commit = async () => {
    const next = value.trim();
    setEditing(false);
    if (next === (title ?? "").trim()) return;
    const previous = title;
    onRenamed(next || null); // optimistic
    try {
      const res = await api.renameSession(sessionId, next, profile);
      onRenamed(res.title || null);
    } catch {
      onRenamed(previous); // rollback
    }
  };

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => {
            setValue(title ?? "");
            setEditing(true);
          }}
          aria-label="Rename session"
          title="Rename session"
          className="rounded p-1 text-text-tertiary transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void regenerate()}
          disabled={regenerating}
          aria-label="Regenerate title from the conversation"
          title="Regenerate title"
          aria-busy={regenerating}
          className="rounded p-1 text-text-tertiary transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40 disabled:opacity-50"
        >
          <Sparkles className={`h-3.5 w-3.5${regenerating ? " animate-pulse" : ""}`} />
        </button>
      </span>
    );
  }

  return (
    <input
      autoFocus
      onFocus={(event) => event.target.select()}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setEditing(false);
        }
      }}
      aria-label="Session title"
      maxLength={200}
      className="min-w-0 max-w-[16rem] rounded border border-current/20 bg-transparent px-1.5 py-0.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
    />
  );
}
