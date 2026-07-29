import { useState } from "react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Input } from "@nous-research/ui/ui/components/input";
import { ConfirmDialog } from "@nous-research/ui/ui/components/confirm-dialog";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { Send, Save, X } from "lucide-react";

import { api, type EmailSendBody } from "@/lib/api";

export interface ComposerInitial {
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  thread_id?: string;
  in_reply_to?: string;
  references?: string;
}

/**
 * Compose / reply overlay. Sending is the ME path — I click Send, and a
 * confirm dialog shows exactly who it goes to and the subject before it
 * leaves, satisfying "approvals show what will be sent". Drafts are real
 * Gmail drafts, so they also appear on the phone.
 */
export function EmailComposer({
  initial = {},
  onClose,
  onSent,
}: {
  initial?: ComposerInitial;
  onClose: () => void;
  onSent?: () => void;
}) {
  const { toast, showToast } = useToast();
  const [to, setTo] = useState(initial.to ?? "");
  const [cc, setCc] = useState(initial.cc ?? "");
  const [showCc, setShowCc] = useState(!!initial.cc);
  const [subject, setSubject] = useState(initial.subject ?? "");
  const [body, setBody] = useState(initial.body ?? "");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const recipients = to
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const payload = (): EmailSendBody => ({
    to: recipients,
    cc: cc.split(",").map((s) => s.trim()).filter(Boolean),
    subject,
    body,
    thread_id: initial.thread_id,
    in_reply_to: initial.in_reply_to,
    references: initial.references,
  });

  const send = async () => {
    setBusy(true);
    try {
      await api.sendEmail(payload());
      showToast("Message sent", "success");
      onSent?.();
      onClose();
    } catch {
      showToast("Could not send message", "error");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const saveDraft = async () => {
    setBusy(true);
    try {
      await api.createEmailDraft(payload());
      showToast("Saved to Gmail drafts", "success");
      onClose();
    } catch {
      showToast("Could not save draft", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center bg-black/50 p-0 backdrop-blur-[2px] sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={initial.thread_id ? "Reply" : "New message"}
        className="flex max-h-[92dvh] w-full max-w-2xl flex-col rounded-t-xl border border-border bg-background-base shadow-xl sm:rounded-xl"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold">
            {initial.thread_id ? "Reply" : "New message"}
          </h2>
          <Button ghost size="icon" onClick={onClose} aria-label="Close composer">
            <X />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
          <label className="flex items-center gap-2 text-sm">
            <span className="w-14 shrink-0 text-text-secondary">To</span>
            <Input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="alice@example.com, bob@example.com"
              aria-label="To"
              autoFocus
            />
            {!showCc && (
              <Button size="sm" ghost onClick={() => setShowCc(true)}>
                Cc
              </Button>
            )}
          </label>
          {showCc && (
            <label className="flex items-center gap-2 text-sm">
              <span className="w-14 shrink-0 text-text-secondary">Cc</span>
              <Input value={cc} onChange={(e) => setCc(e.target.value)} aria-label="Cc" />
            </label>
          )}
          <label className="flex items-center gap-2 text-sm">
            <span className="w-14 shrink-0 text-text-secondary">Subject</span>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              aria-label="Subject"
            />
          </label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            aria-label="Message body"
            rows={12}
            className="min-h-40 flex-1 resize-none rounded-md border border-input bg-transparent p-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
            placeholder="Write your message…"
          />
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
          <Button
            prefix={<Send />}
            onClick={() => setConfirming(true)}
            disabled={busy || recipients.length === 0}
          >
            Send
          </Button>
          <Button outlined prefix={<Save />} onClick={() => void saveDraft()} disabled={busy}>
            Save draft
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void send()}
        loading={busy}
        title="Send this message?"
        description={`To: ${recipients.join(", ") || "(no recipients)"}\nSubject: ${subject || "(no subject)"}`}
        confirmLabel="Send"
        cancelLabel="Cancel"
      />
      <Toast toast={toast} />
    </div>
  );
}
