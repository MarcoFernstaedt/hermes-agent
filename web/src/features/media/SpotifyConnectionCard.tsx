import { Button } from "@nous-research/ui/ui/components/button";
import { ConfirmDialog } from "@nous-research/ui/ui/components/confirm-dialog";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { CheckCircle2, LinkIcon, RefreshCw, Unlink } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { useData } from "@/lib/use-data";

/**
 * Spotify connection status + disconnect, so linking isn't a CLI-only action.
 * Read-only status comes from the backend (which never exposes the token);
 * disconnect clears the stored auth. Connecting still runs
 * `hermes auth spotify` on the server (the OAuth redirect flow lives there),
 * which we state plainly rather than pretend to do in-page.
 */
export function SpotifyConnectionCard({ onChanged }: { onChanged?: () => void }) {
  const { toast, showToast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const conn = useData("spotify:connection", api.getSpotifyConnection, {
    refreshInterval: 0,
  });

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // In-interface re-auth: the fallback when the token expires or is missing, so
  // the user never has to drop to a server CLI. Opens Spotify's authorize page
  // and polls the server until the loopback callback completes the exchange.
  const reconnect = async () => {
    setReconnecting(true);
    try {
      const started = await api.startSpotifyReauth();
      if (!started.configured || !started.auth_url) {
        setReconnecting(false);
        showToast(
          started.needs_client_id
            ? "Set a Spotify client ID first (API Keys / setup guide)."
            : "Spotify re-auth is unavailable.",
          "error",
        );
        return;
      }
      window.open(started.auth_url, "_blank", "noopener,noreferrer");
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        let status;
        try {
          status = await api.getSpotifyReauthStatus();
        } catch {
          return; // transient; keep polling
        }
        if (status.status === "connected") {
          if (pollRef.current) clearInterval(pollRef.current);
          setReconnecting(false);
          showToast("Spotify reconnected", "success");
          conn.mutate();
          onChanged?.();
        } else if (status.status === "error") {
          if (pollRef.current) clearInterval(pollRef.current);
          setReconnecting(false);
          showToast(`Spotify re-auth failed: ${status.detail || "unknown"}`, "error");
        }
      }, 2000);
    } catch {
      setReconnecting(false);
      showToast("Could not start Spotify re-auth", "error");
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await api.disconnectSpotify();
      showToast("Spotify disconnected", "success");
      conn.mutate(); // refetch status
      onChanged?.();
    } catch {
      showToast("Could not disconnect Spotify", "error");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const data = conn.data;
  const connected = !!data?.connected;

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
      aria-busy={conn.isLoading}
    >
      <div className="flex min-w-0 items-center gap-2">
        {connected ? (
          <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
        ) : (
          <LinkIcon className="size-4 shrink-0 text-text-tertiary" aria-hidden />
        )}
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {connected ? "Spotify connected" : "Spotify not connected"}
          </p>
          <p className="truncate text-xs text-muted-foreground" role="status">
            {conn.isLoading
              ? "Checking connection…"
              : reconnecting
                ? "Waiting for Spotify authorization…"
                : connected
                  ? data?.needs_reauth
                    ? "Needs reauthorization — reconnect to restore playback."
                    : data?.account
                      ? `Signed in as ${data.account}`
                      : "Linked"
                  : "Not connected — reconnect to enable playback."}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {(!connected || data?.needs_reauth) && (
          <Button
            size="sm"
            prefix={<RefreshCw className={reconnecting ? "animate-spin" : undefined} />}
            onClick={() => void reconnect()}
            disabled={reconnecting || conn.isLoading}
          >
            {reconnecting ? "Reconnecting…" : "Reconnect Spotify"}
          </Button>
        )}
        {connected && (
          <Button
            outlined
            size="sm"
            prefix={<Unlink />}
            onClick={() => setConfirming(true)}
            disabled={busy}
          >
            Disconnect
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirming}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void disconnect()}
        loading={busy}
        title="Disconnect Spotify?"
        description="This clears the stored Spotify authorization on the server. Playback controls will stop working until you reconnect — you can do that right here with Reconnect Spotify."
        confirmLabel="Disconnect"
        cancelLabel="Cancel"
      />
      <Toast toast={toast} />
    </div>
  );
}
