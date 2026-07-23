import { useState } from "react";
import { Pencil } from "lucide-react";
import { api } from "@/lib/api";

/**
 * Inline rename affordance beside the chat header title. Click the pencil to
 * edit; Enter commits, Escape reverts, blur commits. Persists via the
 * session patch endpoint and reports the new title so the header updates
 * optimistically. Rolls back on failure.
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
