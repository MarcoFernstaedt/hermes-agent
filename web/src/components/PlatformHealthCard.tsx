import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleHelp, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import type { HealthStatus, SystemHealth } from "@/lib/api";

/**
 * Platform health — one honest read of the app's own condition, aggregated from
 * signals it already produces: rejected capability declarations, guardrail
 * refusals/failures, the review backlog, and release drift. Read-only; the app
 * tells you how it's doing so you don't have to guess.
 */
export function PlatformHealthCard() {
  const [data, setData] = useState<SystemHealth | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .getSystemHealth()
      .then((d) => alive && setData(d))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return <p className="font-sans text-xs text-text-tertiary">Health unavailable on this runtime.</p>;
  }
  if (!data) {
    return <div className="h-16 animate-pulse rounded-md bg-midground/10" aria-hidden />;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <StatusIcon status={data.status} />
        <span className="font-sans text-sm font-medium">
          {data.status === "ok" ? "All systems healthy" : `Attention: ${data.status}`}
        </span>
      </div>
      <dl className="grid gap-2 sm:grid-cols-2">
        {Object.entries(data.sections).map(([name, section]) => (
          <div
            key={name}
            className="flex items-start gap-2 rounded-md border border-current/10 px-3 py-2"
          >
            <StatusIcon status={section.status} small />
            <div className="flex min-w-0 flex-col">
              <dt className="font-sans text-xs font-medium capitalize text-text-secondary">{name}</dt>
              <dd className="font-sans text-xs text-text-tertiary">{summarize(name, section)}</dd>
            </div>
          </div>
        ))}
      </dl>
    </div>
  );
}

function summarize(name: string, s: Record<string, unknown>): string {
  if (name === "capabilities") return `${s.loaded ?? 0} loaded · ${s.rejected ?? 0} rejected`;
  if (name === "review") {
    const c = (s.counts ?? {}) as Record<string, number>;
    return `${c.pending ?? 0} pending · ${c.failed ?? 0} failed`;
  }
  if (name === "guardrails") return `${s.refused_or_failed ?? 0} refused/failed (7d)`;
  if (name === "build") {
    if (s.commit_drift) return "commit drift — rebuild & restart";
    if (s.version_drift) {
      return `running v${s.version} · installed v${s.installed_version}`;
    }
    return `v${s.version ?? "?"} · in sync`;
  }
  return s.status as string;
}

function StatusIcon({ status, small }: { status: HealthStatus; small?: boolean }) {
  const size = small ? "size-4" : "size-5";
  if (status === "ok") return <CheckCircle2 className={cn(size, "shrink-0 text-success")} aria-label="ok" />;
  if (status === "warn") return <AlertTriangle className={cn(size, "shrink-0 text-warning")} aria-label="warning" />;
  if (status === "error") return <XCircle className={cn(size, "shrink-0 text-destructive")} aria-label="error" />;
  return <CircleHelp className={cn(size, "shrink-0 text-text-tertiary")} aria-label="unknown" />;
}
