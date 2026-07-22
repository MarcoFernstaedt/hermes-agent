import { useCallback, useEffect, useState } from "react";
import { MousePointerClick, RefreshCw } from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { H2 } from "@nous-research/ui/ui/components/typography/h2";
import { Spinner } from "@nous-research/ui/ui/components/spinner";

import { api } from "@/lib/api";
import type { ComputerUseStatus } from "@/lib/api";

/**
 * Computer Use readiness card for the System page. macOS keys off explicit
 * TCC grants (with a Grant action); Windows/Linux key off cua-driver health.
 * Degrades cleanly when the driver isn't installed or the platform has no
 * permission model.
 */
export function ComputerUseSection() {
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [granting, setGranting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api.getComputerUseStatus());
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const grant = useCallback(async () => {
    setGranting(true);
    setNote(null);
    try {
      await api.grantComputerUsePermissions();
      setNote("Approve the macOS dialog attributed to CuaDriver, then refresh.");
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Grant is unavailable on this platform.");
    } finally {
      setGranting(false);
    }
  }, []);

  const readyTone = status?.ready ? "success" : status?.ready === false ? "warning" : "secondary";
  const readyLabel = status?.ready ? "ready" : status?.ready === false ? "not ready" : "unknown";

  return (
    <section className="flex flex-col gap-3">
      <H2 variant="sm" className="flex items-center gap-2 text-muted-foreground">
        <MousePointerClick className="h-4 w-4" /> Computer Use
      </H2>
      <Card>
        <CardContent className="flex flex-col gap-3 py-4">
          {loading ? (
            <div className="flex justify-center py-4">
              <Spinner />
            </div>
          ) : !status ? (
            <p className="text-sm text-muted-foreground">Status unavailable.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={readyTone}>{readyLabel}</Badge>
                <Badge tone="outline">{status.platform}</Badge>
                <Badge tone={status.installed ? "secondary" : "warning"}>
                  {status.installed ? `cua-driver ${status.version ?? "installed"}` : "cua-driver not installed"}
                </Badge>
                {status.platform === "darwin" && (
                  <>
                    <Badge tone={status.accessibility ? "success" : "warning"}>
                      accessibility {status.accessibility ? "✓" : "✗"}
                    </Badge>
                    <Badge tone={status.screen_recording ? "success" : "warning"}>
                      screen recording {status.screen_recording ? "✓" : "✗"}
                    </Badge>
                  </>
                )}
              </div>

              {!status.installed && (
                <p className="text-xs text-text-secondary">
                  Install the driver on the server with{" "}
                  <code className="font-mono-ui">hermes computer-use install</code>.
                </p>
              )}
              {status.error && <p className="text-xs text-warning">{status.error}</p>}
              {status.checks.length > 0 && (
                <ul className="flex flex-col gap-1 text-xs">
                  {status.checks.map((check, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                          check.status === "ok" ? "bg-success" : "bg-warning"
                        }`}
                      />
                      <span className="text-text-secondary">
                        {check.label}
                        {check.message ? ` — ${check.message}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {note && (
                <p role="status" className="text-xs text-text-secondary">
                  {note}
                </p>
              )}

              <div className="flex items-center gap-2">
                <Button size="sm" ghost prefix={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void load()}>
                  Refresh
                </Button>
                {status.can_grant && (
                  <Button
                    size="sm"
                    onClick={() => void grant()}
                    disabled={granting}
                    prefix={granting ? <Spinner /> : undefined}
                  >
                    Grant permissions
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
