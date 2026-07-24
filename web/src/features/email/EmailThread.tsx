import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import type { GmailMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  defaultExpanded,
  isUnread,
  parseSender,
  toRenderable,
} from "./email-model";
import { EmailReader } from "./EmailReader";

/**
 * A conversation view. Renders every message in a Gmail thread as a stacked
 * list of collapsible cards — the newest message and any still-unread messages
 * open by default, older read ones collapse to a one-line summary. Expanding a
 * card reveals its body through the same sandboxed EmailReader used everywhere.
 */
export function EmailThread({ messages }: { messages: GmailMessage[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    defaultExpanded(messages),
  );

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5">
      {messages.map((m, i) => {
        const r = toRenderable(m);
        const open = expanded.has(m.id);
        const unread = isUnread(m);
        const sender = r.from.name || parseSender(r.to).name;
        const isLast = i === messages.length - 1;
        return (
          <div
            key={m.id}
            className={cn(
              "rounded-md border transition-colors",
              open ? "border-border" : "border-border/60",
              unread && "border-primary/40",
            )}
          >
            <button
              type="button"
              onClick={() => toggle(m.id)}
              aria-expanded={open}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40",
                open ? "rounded-t-md" : "rounded-md hover:bg-midground/5",
              )}
            >
              {open ? (
                <ChevronDown className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />
              )}
              {unread && (
                <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
              )}
              <span
                className={cn(
                  "min-w-0 shrink-0 truncate text-sm",
                  unread ? "font-semibold" : "font-medium",
                )}
              >
                {sender}
              </span>
              {!open && (
                <span className="min-w-0 flex-1 truncate text-xs text-text-tertiary">
                  {m.snippet}
                </span>
              )}
              <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-text-tertiary">
                {shortDate(r.date)}
              </span>
            </button>
            {open && (
              <div className="border-t border-border px-3 pb-3 pt-2">
                <p className="mb-1 text-xs text-text-tertiary">
                  <span className="text-text-secondary">
                    &lt;{r.from.email}&gt;
                  </span>
                  {r.date && <span className="ml-2">{r.date}</span>}
                </p>
                {/* Each message keeps its own reader (its own text/HTML +
                    image gate). The last message renders taller for reading. */}
                <div className={cn("min-h-0", isLast ? "h-[46vh]" : "h-[30vh]")}>
                  <EmailReader message={r} />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A compact date for the collapsed row; falls back to the raw header. */
function shortDate(raw: string): string {
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return raw;
  const d = new Date(t);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
