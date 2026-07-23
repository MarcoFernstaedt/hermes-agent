import { Button } from "@nous-research/ui/ui/components/button";
import { ConfirmDialog } from "@nous-research/ui/ui/components/confirm-dialog";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { CheckCircle2, LinkIcon, Unlink } from "lucide-react";
import { useState } from "react";

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
  const conn = useData("spotify:connection", api.getSpotifyConnection, {
    refreshInterval: 0,
  });

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
              : connected
                ? data?.needs_reauth
                  ? "Needs reauthorization — run hermes auth spotify on the server."
                  : data?.account
                    ? `Signed in as ${data.account}`
                    : "Linked"
                : "Run hermes auth spotify on the server to connect."}
          </p>
        </div>
      </div>

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

      <ConfirmDialog
        open={confirming}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void disconnect()}
        loading={busy}
        title="Disconnect Spotify?"
        description="This clears the stored Spotify authorization on the server. Playback controls will stop working until you reconnect with hermes auth spotify."
        confirmLabel="Disconnect"
        cancelLabel="Cancel"
      />
      <Toast toast={toast} />
    </div>
  );
}
