import { useEffect, useMemo, useState } from "react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Input } from "@nous-research/ui/ui/components/input";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { ConfirmDialog } from "@nous-research/ui/ui/components/confirm-dialog";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import {
  Archive,
  MailOpen,
  Paperclip,
  PenSquare,
  RefreshCw,
  Reply,
  Search,
  Star,
  Trash2,
} from "lucide-react";

import { usePageHeader } from "@/contexts/usePageHeader";
import { useIntent } from "@/hooks/useIntent";
import { api } from "@/lib/api";
import { useData } from "@/lib/use-data";
import { cn } from "@/lib/utils";
import { getHeader, parseSender, toRenderable } from "./email-model";
import { EmailComposer, type ComposerInitial } from "./EmailComposer";
import { EmailReader } from "./EmailReader";

export default function EmailPage() {
  const { setTitle } = usePageHeader();
  useEffect(() => setTitle("Email"), [setTitle]);

  const { toast, showToast } = useToast();
  const [query, setQuery] = useState("is:unread");
  const [submitted, setSubmitted] = useState("is:unread");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingTrash, setPendingTrash] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerInitial | null>(null);

  // Command-palette "Compose email" opens the composer after navigation.
  useIntent("email:compose", () => setComposer({}));

  const conn = useData("email:connection", api.getEmailConnection);
  const list = useData(
    conn.data?.connected ? `email:list:${submitted}` : null,
    () => api.listEmail({ q: submitted, maxResults: 25 }),
  );
  const ids = useMemo(
    () => (list.data?.messages ?? []).map((m) => m.id),
    [list.data],
  );
  const meta = useData(
    ids.length ? `email:meta:${ids.join(",")}` : null,
    () => api.getEmailMetadata(ids),
  );
  const rows = meta.data?.messages ?? [];

  const message = useData(
    selectedId ? `email:msg:${selectedId}` : null,
    () => api.getEmailMessage(selectedId!, "full"),
  );
  const renderable = message.data ? toRenderable(message.data) : null;

  const refreshList = () => {
    list.mutate();
    meta.mutate();
  };

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      showToast(ok, "success");
      refreshList();
    } catch {
      showToast("Action failed", "error");
    }
  };

  const openReply = () => {
    if (!message.data || !renderable) return;
    const messageId = getHeader(message.data.payload, "Message-ID");
    const quoted = renderable.text
      ? `\n\nOn ${renderable.date}, ${renderable.from.name} wrote:\n> ${renderable.text.replace(/\n/g, "\n> ")}`
      : "";
    setComposer({
      to: renderable.from.email,
      subject: /^re:/i.test(renderable.subject) ? renderable.subject : `Re: ${renderable.subject}`,
      thread_id: message.data.threadId,
      in_reply_to: messageId || undefined,
      references: messageId || undefined,
      body: quoted,
    });
  };

  if (conn.isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-text-secondary">
        <Spinner /> Checking Gmail connection…
      </div>
    );
  }

  if (!conn.data?.connected || conn.data?.needs_reauth) {
    return (
      <div className="mx-auto max-w-md p-8 text-center" role="status">
        <MailOpen className="mx-auto mb-3 size-8 text-text-tertiary" aria-hidden />
        <h1 className="text-lg font-semibold">
          {conn.data?.needs_reauth ? "Gmail needs reauthorization" : "Gmail not connected"}
        </h1>
        <p className="mt-2 text-sm text-text-secondary">
          Run <code>python google_api.py</code> setup / <code>hermes</code> Google auth on the
          server to {conn.data?.needs_reauth ? "reconnect" : "connect"} Gmail, then retry.
        </p>
        <Button className="mt-4" outlined prefix={<RefreshCw />} onClick={() => conn.mutate()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 sm:p-4">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(query.trim());
        }}
      >
        <label className="sr-only" htmlFor="email-search">
          Search email with Gmail query syntax
        </label>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-tertiary" aria-hidden />
          <Input
            id="email-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="is:unread from:alice has:attachment newer_than:7d"
            className="pl-8"
          />
        </div>
        <Button type="submit" outlined>Search</Button>
        <Button ghost size="icon" onClick={refreshList} aria-label="Refresh" title="Refresh">
          <RefreshCw className={cn(list.isValidating && "animate-spin")} />
        </Button>
        <Button prefix={<PenSquare />} onClick={() => setComposer({})}>
          Compose
        </Button>
      </form>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(18rem,24rem)_1fr]">
        {/* Message list */}
        <div className="min-h-0 overflow-y-auto rounded-md border border-border" role="list" aria-label="Messages">
          {list.isLoading || meta.isLoading ? (
            <div className="flex items-center justify-center gap-2 p-6 text-sm text-text-secondary">
              <Spinner /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-text-secondary">No messages match.</p>
          ) : (
            rows.map((r) => {
              const sender = parseSender(r.from);
              const active = r.id === selectedId;
              return (
                <button
                  key={r.id}
                  type="button"
                  role="listitem"
                  onClick={() => setSelectedId(r.id)}
                  aria-current={active ? "true" : undefined}
                  aria-label={`${r.unread ? "Unread. " : ""}${sender.name}. ${r.subject || "(no subject)"}. ${r.snippet}`}
                  className={cn(
                    "flex w-full flex-col gap-0.5 border-b border-border/60 px-3 py-2 text-left",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40",
                    active ? "bg-primary/10" : "hover:bg-midground/5",
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    {r.unread && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />}
                    <span className={cn("min-w-0 flex-1 truncate text-sm", r.unread ? "font-semibold" : "font-medium text-text-secondary")}>
                      {sender.name}
                    </span>
                    {r.has_attachment && <Paperclip className="size-3 shrink-0 text-text-tertiary" aria-hidden />}
                    {r.starred && <Star className="size-3 shrink-0 fill-current text-warning" aria-hidden />}
                  </span>
                  <span className="truncate text-sm">{r.subject || "(no subject)"}</span>
                  <span className="truncate text-xs text-text-tertiary">{r.snippet}</span>
                </button>
              );
            })
          )}
        </div>

        {/* Reader */}
        <div className="flex min-h-0 flex-col rounded-md border border-border">
          {!selectedId ? (
            <div className="flex h-full items-center justify-center p-6 text-sm text-text-tertiary">
              Select a message to read.
            </div>
          ) : message.isLoading || !renderable ? (
            <div className="flex h-full items-center justify-center gap-2 p-6 text-sm text-text-secondary">
              <Spinner /> Loading message…
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col p-3">
              <div className="mb-2 border-b border-border pb-2">
                <h1 className="text-base font-semibold">{renderable.subject || "(no subject)"}</h1>
                <p className="mt-0.5 text-sm text-text-secondary">
                  <span className="font-medium text-foreground">{renderable.from.name}</span>{" "}
                  <span className="text-text-tertiary">&lt;{renderable.from.email}&gt;</span>
                </p>
                <p className="text-xs text-text-tertiary">{renderable.date}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button size="sm" prefix={<Reply />} onClick={openReply}>
                    Reply
                  </Button>
                  <Button size="sm" outlined prefix={<Archive />}
                    onClick={() => void act(() => api.modifyEmail(selectedId, [], ["INBOX"]), "Archived")}>
                    Archive
                  </Button>
                  <Button size="sm" outlined prefix={<MailOpen />}
                    onClick={() => void act(() => api.modifyEmail(selectedId, [], ["UNREAD"]), "Marked read")}>
                    Mark read
                  </Button>
                  <Button size="sm" outlined prefix={<Star />}
                    onClick={() => void act(() => api.modifyEmail(selectedId, ["STARRED"], []), "Starred")}>
                    Star
                  </Button>
                  <Button size="sm" outlined prefix={<Trash2 />}
                    onClick={() => setPendingTrash(selectedId)}>
                    Trash
                  </Button>
                </div>
              </div>
              <EmailReader message={renderable} />
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pendingTrash !== null}
        onCancel={() => setPendingTrash(null)}
        onConfirm={() => {
          const id = pendingTrash!;
          setPendingTrash(null);
          setSelectedId(null);
          void act(() => api.trashEmail(id), "Moved to Trash");
        }}
        loading={false}
        title="Move to Trash?"
        description="This moves the message to Gmail Trash. It's recoverable from Gmail for 30 days."
        confirmLabel="Trash"
        cancelLabel="Cancel"
      />
      {composer && (
        <EmailComposer
          initial={composer}
          onClose={() => setComposer(null)}
          onSent={refreshList}
        />
      )}
      <Toast toast={toast} />
    </div>
  );
}
