import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Loader2,
  RefreshCw,
  RotateCcw,
  Undo2,
} from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";

import { api } from "@/lib/api";
import type { UndoApplyResult, UndoEntry, UndoSummary } from "@/lib/api";
import { describeEntry, describeOutcome, sectionsFor } from "@/lib/undoView";
import type { UndoSection } from "@/lib/undoView";

/**
 * What the agent did, and what can be taken back.
 *
 * The journal has always been correct and, until now, unreachable: entries
 * accumulated and no screen read them. That made two things invisible at once
 * — the ordinary undo stack, and the states that exist *precisely* so a person
 * can act on them (`compensation_failed`, `undo_failed`, `reversal_unknown`).
 *
 * Three sections, in this order, and never merged:
 *
 * **Needs attention** comes first and is unconditional. These are reversals
 * that failed, or whose outcome nobody knows. What the owner was told and what
 * is true may differ. Putting them under a list of successful undos is how
 * they go unnoticed for a week.
 *
 * **In progress** is separate because a reversal that has been claimed and is
 * still running is neither done nor failed, and showing it as either would be
 * a false statement about the world.
 *
 * **Can be undone** is the ordinary stack.
 *
 * A conflict is *reported*, never decided. When the note changed since the
 * agent wrote it — most likely because the owner edited it in Obsidian — the
 * undo refuses, says exactly what it found, and leaves the entry offerable.
 * "Undo anyway" is a second, separate action carrying the owner's answer back.
 */
export default function UndoPage() {
  const [summary, setSummary] = useState<UndoSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<
    (UndoApplyResult & { entryId: string }) | null
  >(null);

  const load = useCallback(async () => {
    // Every setState here happens *after* the await. Clearing the error first
    // would be a synchronous state write inside the mount effect, which the
    // React Compiler flags as a cascading render — and it buys nothing: the
    // fetch either replaces the error or sets a new one.
    try {
      const next = await api.getUndo();
      setSummary(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The undo journal could not be read.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred so the loader's setState isn't called synchronously in-effect,
    // which the React Compiler flags as a cascading render. Same pattern as
    // LearningPage and GraphPage.
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  const apply = useCallback(
    async (entryId: string, force: boolean) => {
      setBusyId(entryId);
      try {
        const result = await api.applyUndo({ entryId, force });
        setOutcome({ ...result, entryId });
        // Reload whatever the outcome: a refusal leaves the entry offerable, a
        // failure moves it into the repair list, and a success removes it. All
        // three change what this screen should be showing.
        await load();
      } catch (e) {
        setOutcome({
          undone: false,
          entryId,
          message: e instanceof Error ? e.message : "The undo could not be run.",
        });
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6 pb-8">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Reversible actions the agent recorded. Undoing checks the file first
          and refuses rather than overwriting a change you made since.
        </p>
        <Button ghost size="sm" onClick={() => void load()}>
          <RefreshCw className="size-4" aria-hidden />
          <span className="sr-only">Refresh</span>
        </Button>
      </div>

      {outcome ? (
        <OutcomeBanner
          outcome={outcome}
          busy={busyId === outcome.entryId}
          onForce={() => void apply(outcome.entryId, true)}
          onDismiss={() => setOutcome(null)}
        />
      ) : null}

      {/* Order and membership come from `sectionsFor`, not from this file:
          "needs attention" first is the point of the screen, and it is the
          kind of thing that gets quietly reshuffled by a layout change. */}
      {sectionsFor(summary).map((section) => (
        <Section key={section.key} section={section}>
          {section.entries.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">
              Nothing to undo.
            </p>
          ) : (
            section.entries.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                busy={busyId === entry.id}
                onUndo={
                  section.actionable ? () => void apply(entry.id, false) : undefined
                }
              />
            ))
          )}
        </Section>
      ))}

    </div>
  );
}

function Section({
  section,
  children,
}: {
  section: UndoSection;
  children: React.ReactNode;
}) {
  const headingId = `undo-section-${section.key}`;
  return (
    <section aria-labelledby={headingId}>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 id={headingId} className="text-sm font-semibold">
          {section.title}
        </h2>
        <Badge tone={section.tone === "danger" ? "destructive" : "secondary"}>
          {section.entries.length}
        </Badge>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{section.description}</p>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function EntryRow({
  entry,
  busy,
  onUndo,
}: {
  entry: UndoEntry;
  busy?: boolean;
  onUndo?: () => void;
}) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {entry.needs_repair ? (
              <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
            ) : null}
            <span className="truncate text-sm font-medium">
              {entry.target || entry.action}
            </span>
            <Badge tone="outline" className="shrink-0">
              {entry.status}
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {describeEntry(entry)}
          </p>
        </div>
        {onUndo ? (
          <Button size="sm" outlined disabled={busy} onClick={onUndo}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Undo2 className="size-4" aria-hidden />
            )}
            Undo
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * What just happened, said in the terms the owner can act on.
 *
 * A refusal and a failure are deliberately different messages. A refusal means
 * nothing was attempted and the entry is still offerable, so "Undo anyway" is
 * an option. A failure means the reversal ran and did not take, so retrying is
 * not the next step — looking at it is.
 */
function OutcomeBanner({
  outcome,
  busy,
  onForce,
  onDismiss,
}: {
  outcome: UndoApplyResult & { entryId: string };
  busy: boolean;
  onForce: () => void;
  onDismiss: () => void;
}) {
  // Every judgement here — the tone, the wording, and whether forcing is even
  // offered — comes from `describeOutcome`, so the distinction between "it was
  // refused and is still offerable" and "it ran and did not take" cannot be
  // flattened by a styling change.
  const view = describeOutcome(outcome);
  const tone =
    view.tone === "success"
      ? "border-success/40 bg-success/5"
      : view.tone === "danger"
        ? "border-destructive/40 bg-destructive/5"
        : "border-warning/40 bg-warning/5";

  return (
    <Card className={tone} role="status" aria-live="polite">
      <CardContent className="space-y-2 p-3">
        <p className="text-sm">{view.headline}</p>
        {view.detail ? (
          <p className="text-xs text-muted-foreground">{view.detail}</p>
        ) : null}

        <div className="flex gap-2">
          {view.offerForce ? (
            <Button size="sm" destructive disabled={busy} onClick={onForce}>
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <RotateCcw className="size-4" aria-hidden />
              )}
              Undo anyway
            </Button>
          ) : null}
          <Button size="sm" ghost onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
