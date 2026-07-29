import { useState } from "react";
import {
  AlertTriangle,
  Check,
  Clock,
  Loader2,
  Pencil,
  ShieldAlert,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  canDecide,
  cardPhase,
  hasVerdictFacts,
  isIrreversible,
  permanenceSentence,
  statusSentence,
  verdictFacts,
  type Permanence,
} from "@/lib/itemCard";

/**
 * The approve / deny / modify card.
 *
 * Content order is fixed and deliberate: what happened, the context it came
 * from, the work already staged, the verified verdict facts, exactly what
 * approval will do, then the actions. The owner should never reach a button
 * before they have read the consequence.
 *
 * On layout: the card does **not** reserve its maximum height. Doing that keeps
 * the footprint stable but leaves enormous blank regions on short items, which
 * is worse than the reflow it prevents. Instead the header and action row have
 * fixed geometry and the artifact sits in a bounded scroll region, so a long
 * draft cannot push the buttons off screen and a short one wastes nothing.
 */
export interface ItemCardProps {
  item: {
    id: string;
    state: string;
    title: string;
    summary?: string;
    kind: string;
    risk: string;
    source: string;
    reason?: string;
    outcome?: string;
    attempt?: number;
    payload?: Record<string, unknown>;
    provenance?: Record<string, unknown>;
  };
  /** What approving will actually do, in plain words. */
  consequence: string;
  permanence: Permanence;
  /** The staged artifact, shown in full — never truncated behind a click. */
  artifact?: string;
  busy?: boolean;
  onApprove(): void;
  onDeny(reason: string): void;
  onModify(instruction: string): void;
  onSnooze(): void;
  /** Why this surfaced, and how to tune the rule that produced it. */
  onTuneRule?(): void;
}

export function ItemCard({
  item,
  consequence,
  permanence,
  artifact,
  busy = false,
  onApprove,
  onDeny,
  onModify,
  onSnooze,
  onTuneRule,
}: ItemCardProps) {
  const phase = cardPhase(item.state);
  const decidable = canDecide(item.state) && !busy;
  const [denying, setDenying] = useState(false);
  const [modifying, setModifying] = useState(false);
  const [text, setText] = useState("");
  const facts = verdictFacts({ ...(item.provenance ?? {}), ...(item.payload ?? {}) });

  return (
    <article
      aria-labelledby={`item-${item.id}-title`}
      data-phase={phase}
      className={cn(
        "flex flex-col rounded-lg border transition-colors",
        "duration-[var(--motion-state)] ease-[var(--ease-out)]",
        phase === "attention"
          ? "border-destructive/45 bg-destructive/5"
          : phase === "working"
            ? "border-primary/35 bg-primary/[0.04]"
            : "border-current/10 bg-midground/[0.02]",
      )}
    >
      {/* 1. What happened — one plain sentence, and the kind it belongs to. */}
      <header className="flex flex-wrap items-start gap-2 p-3">
        <span className="rounded bg-midground/10 px-1.5 py-0.5 font-mono-ui text-xs uppercase tracking-[0.08em] text-text-secondary">
          {item.kind}
        </span>
        <h3 id={`item-${item.id}-title`} className="min-w-0 flex-1 text-sm font-medium">
          {item.title}
        </h3>
        {item.risk !== "low" && (
          <span className="inline-flex items-center gap-1 text-xs text-warning">
            <ShieldAlert className="size-3.5" aria-hidden /> {item.risk} risk
          </span>
        )}
      </header>

      {item.summary && (
        <p className="px-3 pb-2 text-xs leading-relaxed text-text-secondary">{item.summary}</p>
      )}

      {/* 2 + 3. Context and the work already staged, in a bounded scroll region
          so a long draft cannot push the decision buttons off the screen. */}
      {artifact && (
        <div className="mx-3 mb-2 max-h-64 overflow-y-auto rounded-md border border-current/10 bg-background/50">
          <pre className="whitespace-pre-wrap break-words p-3 font-mono-ui text-xs leading-relaxed text-text-secondary">
            {artifact}
          </pre>
        </div>
      )}

      {/* 4. Verified facts only. Absent entirely when no review happened. */}
      {hasVerdictFacts(facts) && (
        <dl className="mx-3 mb-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-current/10 pt-2 text-xs">
          {facts.verdict && <Fact label="Verdict" value={facts.verdict} />}
          {facts.trigger && <Fact label="Why gated" value={facts.trigger} />}
          {facts.tier && <Fact label="Tier" value={facts.tier} />}
          {facts.scope && <Fact label="Scope" value={facts.scope} />}
        </dl>
      )}

      {/* 5. Exactly what happens on approve — before any button. */}
      <div className="mx-3 mb-2 flex flex-col gap-1 rounded-md border border-current/10 px-3 py-2">
        <p className="text-xs leading-relaxed text-text-secondary">{consequence}</p>
        <p
          className={cn(
            "text-xs font-medium",
            isIrreversible(permanence) ? "text-warning" : "text-text-tertiary",
          )}
        >
          {permanenceSentence(permanence)}
        </p>
      </div>

      <p
        className={cn(
          "px-3 pb-2 text-xs",
          phase === "attention" ? "text-destructive" : "text-text-tertiary",
        )}
      >
        {phase === "working" && (
          <Loader2 className="mr-1.5 inline size-3 motion-safe:animate-spin" aria-hidden />
        )}
        {phase === "attention" && (
          <AlertTriangle className="mr-1.5 inline size-3" aria-hidden />
        )}
        {statusSentence(item)}
      </p>

      {/* 6. Actions — fixed geometry, so they never move under the pointer. */}
      {decidable && !denying && !modifying && (
        <div className="flex flex-wrap items-center gap-2 border-t border-current/10 p-3">
          <button type="button" onClick={onApprove} className={primaryBtn}>
            <Check className="size-3.5" aria-hidden /> Approve
          </button>
          <button type="button" onClick={() => setModifying(true)} className={quietBtn}>
            <Pencil className="size-3.5" aria-hidden /> Modify
          </button>
          <button type="button" onClick={() => setDenying(true)} className={quietBtn}>
            <X className="size-3.5" aria-hidden /> Deny
          </button>
          <button type="button" onClick={onSnooze} className={quietBtn}>
            <Clock className="size-3.5" aria-hidden /> Snooze
          </button>
          {onTuneRule && (
            <button
              type="button"
              onClick={onTuneRule}
              className="ml-auto text-xs text-text-tertiary underline-offset-2 hover:text-midground hover:underline"
            >
              Why am I seeing this?
            </button>
          )}
        </div>
      )}

      {/* Modify stays inside the card — the artifact above never leaves view. */}
      {modifying && (
        <InlineInput
          label="Describe the change"
          placeholder="Make it shorter and drop the second paragraph"
          submitLabel="Regenerate"
          value={text}
          onChange={setText}
          onCancel={() => {
            setModifying(false);
            setText("");
          }}
          onSubmit={() => {
            onModify(text);
            setModifying(false);
            setText("");
          }}
        />
      )}

      {denying && (
        <InlineInput
          label="Why are you denying this?"
          placeholder="Wrong recipient"
          submitLabel="Deny"
          destructive
          value={text}
          onChange={setText}
          onCancel={() => {
            setDenying(false);
            setText("");
          }}
          onSubmit={() => {
            // A reason is feedback for this category; a bare rejection is noise.
            onDeny(text);
            setDenying(false);
            setText("");
          }}
        />
      )}
    </article>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <dt className="shrink-0 uppercase tracking-[0.08em] text-text-tertiary">{label}</dt>
      <dd className="min-w-0 truncate font-mono-ui text-text-secondary">{value}</dd>
    </div>
  );
}

function InlineInput({
  label,
  placeholder,
  submitLabel,
  value,
  destructive = false,
  onChange,
  onCancel,
  onSubmit,
}: {
  label: string;
  placeholder: string;
  submitLabel: string;
  value: string;
  destructive?: boolean;
  onChange(v: string): void;
  onCancel(): void;
  onSubmit(): void;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-current/10 p-3">
      <label className="flex flex-col gap-1 text-xs text-text-secondary">
        {label}
        <textarea
          autoFocus
          rows={2}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit();
            if (e.key === "Escape") {
              e.stopPropagation();
              onCancel();
            }
          }}
          className="w-full resize-y rounded-md border border-current/15 bg-background/60 p-2 font-sans text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground/40"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSubmit}
          className={cn(primaryBtn, destructive && "bg-destructive/90 text-background")}
        >
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel} className={quietBtn}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const primaryBtn = cn(
  "inline-flex items-center gap-1 rounded-md bg-midground/90 px-2.5 py-1.5",
  "font-sans text-xs text-background transition-opacity hover:opacity-90",
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground/50",
  "disabled:opacity-50",
);

const quietBtn = cn(
  "inline-flex items-center gap-1 rounded-md border border-current/15 px-2.5 py-1.5",
  "font-sans text-xs text-text-secondary transition-colors hover:text-midground",
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground/40",
  "disabled:opacity-50",
);
