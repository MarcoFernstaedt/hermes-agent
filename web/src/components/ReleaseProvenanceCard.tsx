import { useEffect, useState } from "react";
import { GitCommitHorizontal, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import type { CommitInfo, SystemProvenance } from "@/lib/api";

/**
 * Release provenance — what backend commit is running vs. what commit the
 * served frontend was built from. Surfaces the "stale runtime" drift the
 * on-machine recon flagged: a checkout can quietly serve an older build than
 * the one you shipped. Read-only, one glance, with a loud banner on drift.
 */
export function ReleaseProvenanceCard() {
  const [data, setData] = useState<SystemProvenance | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .getProvenance()
      .then((d) => alive && setData(d))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <p className="font-sans text-xs text-text-tertiary">
        Release info unavailable on this runtime.
      </p>
    );
  }
  if (!data) {
    return (
      <div className="h-16 animate-pulse rounded-md bg-midground/10" aria-hidden />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {data.commit_drift && (
        <div
          role="alert"
          className={cn(
            "flex items-start gap-2 rounded-md",
            "border border-warning/40 bg-warning/10 px-3 py-2",
            "text-warning",
          )}
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p className="font-sans text-xs leading-snug">
            <span className="font-semibold">Release drift.</span> The served
            frontend was built from a different commit than the running backend.
            Rebuild the frontend and restart the service so they match.
          </p>
        </div>
      )}
      <dl className="grid gap-3 sm:grid-cols-2">
        <CommitBlock label="Backend (running)" info={data.backend} />
        <CommitBlock label="Frontend (served build)" info={data.frontend} />
      </dl>
      <p className="font-mono-ui text-xs tracking-[0.04em] text-text-tertiary">
        python {data.process.python} · up{" "}
        {formatUptime(data.process.uptime_seconds)}
      </p>
    </div>
  );
}

function CommitBlock({ label, info }: { label: string; info: CommitInfo }) {
  const unknown = info.commit === "unknown";
  return (
    <div className="flex flex-col gap-1">
      <dt className="font-sans text-xs uppercase tracking-[0.1em] text-text-tertiary">
        {label}
      </dt>
      <dd className="flex items-center gap-2 font-mono-ui text-sm text-text-secondary">
        <GitCommitHorizontal className="size-4 shrink-0 text-text-tertiary" aria-hidden />
        {unknown ? (
          <span className="text-text-tertiary">unknown</span>
        ) : (
          <>
            <span className="tabular-nums">{info.commit_short}</span>
            <span className="text-text-tertiary">· {info.branch}</span>
            {info.dirty ? (
              <span className="text-warning" title="Working tree had uncommitted changes">
                · dirty
              </span>
            ) : null}
          </>
        )}
      </dd>
      {info.built_at ? (
        <span className="font-sans text-xs text-text-tertiary">
          built {new Date(info.built_at).toLocaleString()}
        </span>
      ) : null}
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}
