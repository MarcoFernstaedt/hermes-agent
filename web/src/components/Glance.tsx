import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CircleDot, Loader2, OctagonAlert, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  deriveGlance,
  glanceTone,
  shouldAnnounce,
  type AgentActivity,
  type Glance as GlanceModel,
} from "@/lib/glance";

/**
 * The glance — Imperator's heartbeat, present on every route.
 *
 * Three questions, answered permanently and in half a second: is anything
 * waiting on me, is Imperator working, is anything broken. It lives in the
 * shell rather than on a page because the whole premise is that pages change
 * underneath it and this does not.
 *
 * The live region is the delicate part. It carries only transitions
 * `shouldAnnounce` judges meaningful — never the token-level churn of a turn in
 * flight, which would make the app hostile to anyone listening rather than
 * looking. Visual state updates continuously; spoken state does not.
 */
export function Glance({
  blockingCount,
  activity,
  toolName,
  problems,
  collapsed = false,
  onOpenStream,
}: {
  blockingCount: number;
  activity: AgentActivity;
  toolName?: string;
  problems: string[];
  collapsed?: boolean;
  onOpenStream?: () => void;
}) {
  const glance = deriveGlance({ blockingCount, activity, toolName, problems });
  const tone = glanceTone(glance);

  // Only the text we have decided to say out loud reaches the live region.
  const [spoken, setSpoken] = useState("");
  const previous = useRef<GlanceModel | null>(null);

  useEffect(() => {
    if (shouldAnnounce(previous.current, glance)) {
      setSpoken(glance.announcement);
    }
    previous.current = glance;
  }, [glance]);

  const body = (
    <>
      <ActivityIcon activity={glance.activity} tone={tone} />
      {!collapsed && (
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate font-sans text-xs tracking-[0.08em]">
            {glance.blockingCount > 0
              ? `${glance.blockingCount} waiting`
              : glance.activityLabel}
          </span>
          <span className="truncate font-sans text-xs text-text-tertiary">
            {glance.blockingCount > 0 ? glance.activityLabel : statusLine(glance)}
          </span>
        </span>
      )}
      {glance.degraded && (
        <AlertTriangle
          className={cn("size-3.5 shrink-0", collapsed ? "" : "ml-auto", "text-warning")}
          aria-hidden
        />
      )}
    </>
  );

  const shell = cn(
    "flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors",
    "duration-[var(--motion-state)] ease-[var(--ease-out)]",
    tone === "attention" && "border-primary/45 bg-primary/10 text-foreground",
    tone === "degraded" && "border-warning/40 bg-warning/5 text-warning",
    tone === "working" && "border-current/15 text-text-secondary",
    tone === "calm" && "border-current/10 text-text-tertiary",
    collapsed && "justify-center px-2",
  );

  return (
    <div className={cn("px-3 pb-2", collapsed && "px-2")}>
      {/*
        One live region for the whole app's status. Polite, and fed only by
        meaningful transitions — see `shouldAnnounce`.
      */}
      <p aria-live="polite" className="sr-only">
        {spoken}
      </p>

      {onOpenStream ? (
        <button
          type="button"
          onClick={onOpenStream}
          // The visible text is a summary; the label is the full sentence, so a
          // screen-reader user gets the same three answers a sighted glance does.
          aria-label={glance.announcement}
          title={glance.announcement}
          className={cn(
            shell,
            "hover:border-current/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground/40",
          )}
        >
          {body}
        </button>
      ) : (
        <div className={shell} role="status" aria-label={glance.announcement}>
          {body}
        </div>
      )}
    </div>
  );
}

function statusLine(g: GlanceModel): string {
  if (g.problems.length === 1) return g.problems[0];
  if (g.problems.length > 1) return `${g.problems.length} systems degraded`;
  return "Nothing waiting";
}

function ActivityIcon({ activity, tone }: { activity: AgentActivity; tone: string }) {
  const cls = "size-4 shrink-0";
  if (activity === "offline") return <WifiOff className={cls} aria-hidden />;
  if (activity === "faulted") return <OctagonAlert className={cls} aria-hidden />;
  if (activity === "idle") {
    return (
      <CircleDot
        className={cn(cls, tone === "attention" ? "text-primary" : "text-text-tertiary")}
        aria-hidden
      />
    );
  }
  // Working of any kind: one spinner, stilled under reduced motion so the
  // state is still legible without the movement.
  return (
    <Loader2
      className={cn(cls, "motion-safe:animate-spin motion-reduce:animate-none")}
      aria-hidden
    />
  );
}
