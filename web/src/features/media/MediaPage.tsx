import { useState, type FormEvent, type KeyboardEvent } from "react";
import {
  BookOpen,
  Headphones,
  Music,
  Pause,
  Play,
  RefreshCw,
  Search,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";

import { cn } from "@/lib/utils";
import { useMedia } from "./MediaProvider";
import {
  MEDIA_SOURCES,
  SOURCE_LABELS,
  isMediaSourceDisabled,
  moveMediaSourceFocus,
  type MediaNavigationKey,
  type MediaSource,
} from "./media-source";

function SpotifyPanel() {
  const {
    state,
    spotify,
    searchResults,
    searchPending,
    refreshSpotify,
    controlSpotify,
    searchSpotify,
  } = useMedia();
  const [query, setQuery] = useState("");
  const deviceId = spotify?.playback?.device?.id ?? undefined;
  const pending = state.pendingCommand !== null;
  const status = state.spotify;
  const canControl = status.status === "ready" && !pending;

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    void searchSpotify(query);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,.65fr)]">
      <div className="space-y-4">
        <Card>
          <CardContent className="space-y-5 py-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Spotify playback</h2>
                <p
                  className="text-sm text-muted-foreground"
                  role={status.status === "error" ? "alert" : "status"}
                  aria-live="polite"
                >
                  {status.message}
                </p>
              </div>
              <Button ghost size="icon" onClick={() => void refreshSpotify()} aria-label="Retry Spotify connection">
                <RefreshCw />
              </Button>
            </div>

            {status.status === "disconnected" && (
              <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                Spotify is disconnected. Run <code>hermes auth spotify</code> on the server, then retry.
              </p>
            )}
            {status.status === "empty" && (
              <p className="rounded-md border border-border p-3 text-sm">
                No active player. Open Spotify on a listed device or transfer playback below.
              </p>
            )}

            {spotify?.playback?.item && (
              <div>
                <p className="font-medium">{spotify.playback.item.name}</p>
                <p className="text-sm text-muted-foreground">
                  {spotify.playback.item.artists.join(", ") || "Unknown artist"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {spotify.playback.device?.name
                    ? `Playing on ${spotify.playback.device.name}`
                    : "Choose a playback device"}
                </p>
              </div>
            )}

            <div className="flex items-center gap-2" aria-label="Spotify playback controls">
              <Button size="icon" onClick={() => void controlSpotify({ action: "previous", device_id: deviceId })} disabled={!canControl} aria-label="Spotify previous track">
                <SkipBack />
              </Button>
              <Button
                size="icon"
                onClick={() => void controlSpotify({
                  action: spotify?.playback?.is_playing ? "pause" : "play",
                  device_id: deviceId,
                }, !spotify?.playback?.is_playing)}
                disabled={!canControl}
                aria-label={spotify?.playback?.is_playing ? "Spotify pause" : "Spotify play"}
              >
                {spotify?.playback?.is_playing ? <Pause /> : <Play />}
              </Button>
              <Button size="icon" onClick={() => void controlSpotify({ action: "next", device_id: deviceId })} disabled={!canControl} aria-label="Spotify next track">
                <SkipForward />
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-4 py-6">
            <h2 className="font-semibold">Search Spotify</h2>
            <form className="flex gap-2" role="search" onSubmit={submitSearch}>
              <label className="min-w-0 flex-1">
                <span className="sr-only">Search tracks</span>
                <input
                  className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
                  value={query}
                  maxLength={120}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder="Track or artist"
                />
              </label>
              <Button type="submit" disabled={!query.trim() || searchPending} aria-label="Search Spotify">
                <Search /> Search
              </Button>
            </form>
            <p className="sr-only" aria-live="polite">
              {searchPending ? "Searching Spotify." : `${searchResults.length} Spotify results.`}
            </p>
            <ul className="space-y-2" aria-label="Spotify search results">
              {searchResults.map((item) => (
                <li key={item.uri ?? `${item.name}-${item.artists.join("-")}`} className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.name ?? "Unknown track"}</p>
                    <p className="truncate text-xs text-muted-foreground">{item.artists.join(", ")}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" disabled={!item.uri} onClick={() => item.uri && void controlSpotify({ action: "play_uri", uri: item.uri, device_id: deviceId }, true)}>
                      Play
                    </Button>
                    <Button size="sm" ghost disabled={!item.uri} onClick={() => item.uri && void controlSpotify({ action: "queue", uri: item.uri, device_id: deviceId })}>
                      Queue
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <Card>
          <CardContent className="space-y-3 py-5">
            <h2 className="font-semibold">Devices</h2>
            {spotify?.devices.length ? (
              <ul className="space-y-2">
                {spotify.devices.map((device) => (
                  <li key={device.id} className="flex items-center justify-between gap-2 rounded-md border border-border p-3">
                    <span className="min-w-0 truncate text-sm">
                      {device.name ?? "Unnamed device"}{device.is_active ? " — active" : ""}
                    </span>
                    <Button
                      size="sm"
                      disabled={device.is_restricted || device.is_active || pending}
                      onClick={() => void controlSpotify({ action: "transfer", device_id: device.id, play: true })}
                      aria-label={`Transfer playback to ${device.name ?? "device"}`}
                    >
                      Transfer
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No Spotify devices are currently available.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-3 py-5">
            <h2 className="font-semibold">Queue</h2>
            {spotify?.queue.length ? (
              <ol className="space-y-2">
                {spotify.queue.map((item, index) => (
                  <li key={`${item.uri}-${index}`} className="text-sm">
                    <span className="font-medium">{item.name ?? "Unknown track"}</span>
                    <span className="block text-xs text-muted-foreground">{item.artists.join(", ")}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">The Spotify queue is empty.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function AudiobookPanel() {
  const {
    state,
    audiobook,
    audiobookRate,
    selectedChapter,
    selectAudiobook,
    setAudiobookRate,
  } = useMedia();
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,.7fr)]">
      <Card>
        <CardContent className="space-y-4 py-6">
          <div className="flex items-center gap-3">
            <Headphones className="h-5 w-5" />
            <div>
              <h2 className="font-semibold">{audiobook?.book ?? "Audiobook library"}</h2>
              <p className="text-sm text-muted-foreground" role={state.audiobook.status === "error" ? "alert" : "status"} aria-live="polite">
                {state.audiobook.message}
              </p>
            </div>
          </div>
          {selectedChapter && (
            <div className="space-y-3 rounded-md border border-border p-4">
              <p className="font-medium">{selectedChapter.title}</p>
              <p className="text-sm text-muted-foreground">
                Playback continues in the persistent dock when you change dashboard pages.
              </p>
              <label className="flex items-center gap-2 text-sm">
                Playback speed
                <select
                  className="min-h-11 rounded-md border border-border bg-background px-2"
                  value={audiobookRate}
                  onChange={(event) => setAudiobookRate(Number(event.currentTarget.value))}
                >
                  {[0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => (
                    <option value={rate} key={rate}>{rate}×</option>
                  ))}
                </select>
              </label>
              <Button onClick={() => selectAudiobook(selectedChapter.id, true)}>
                <Play /> Play chapter
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-4">
          <h2 className="mb-3 font-semibold">Chapters</h2>
          <ol className="max-h-[28rem] space-y-1 overflow-y-auto">
            {audiobook?.chapters.map((chapter) => (
              <li key={chapter.id}>
                <button
                  type="button"
                  className={cn(
                    "min-h-11 w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted",
                    selectedChapter?.id === chapter.id && "bg-muted font-medium",
                  )}
                  onClick={() => selectAudiobook(chapter.id, true)}
                  aria-current={selectedChapter?.id === chapter.id ? "true" : undefined}
                >
                  {chapter.order}. {chapter.title}
                </button>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}

function AppleMusicPanel() {
  return (
    <Card>
      <CardContent className="space-y-2 py-6">
        <div className="flex items-center gap-3">
          <Music className="h-5 w-5" />
          <h2 className="font-semibold">Apple Music</h2>
        </div>
        <p className="text-sm text-muted-foreground" role="status">
          Planned and disabled. No Apple Music authorization, catalog, or playback requests are made.
        </p>
      </CardContent>
    </Card>
  );
}

export function MediaPage({ initialSource = "spotify" }: { initialSource?: MediaSource }) {
  const [activeSource, setActiveSource] = useState<MediaSource>(initialSource);
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, source: MediaSource) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = moveMediaSourceFocus(MEDIA_SOURCES, source, event.key as MediaNavigationKey);
    setActiveSource(next);
    document.getElementById(`media-tab-${next}`)?.focus();
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-1 sm:p-3">
      {/* The app header already carries the page title; keep just the
          one-line description here like every other page. */}
      <p className="text-sm text-muted-foreground">
        Provider-neutral playback for Spotify and owned audiobooks.
      </p>
      <div role="tablist" aria-label="Media source" className="flex gap-1 overflow-x-auto border-b border-border">
        {MEDIA_SOURCES.map((source) => {
          const selected = source === activeSource;
          const disabled = isMediaSourceDisabled(source);
          return (
            <button
              key={source}
              id={`media-tab-${source}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`media-panel-${source}`}
              aria-disabled={disabled}
              tabIndex={selected ? 0 : -1}
              className={cn(
                "min-h-11 whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium",
                selected ? "border-midground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                disabled && "opacity-60",
              )}
              onClick={() => {
                if (!disabled) setActiveSource(source);
              }}
              onKeyDown={(event) => onTabKeyDown(event, source)}
            >
              {source === "audiobooks" && <BookOpen className="mr-2 inline h-4 w-4" aria-hidden />}
              {SOURCE_LABELS[source]}
            </button>
          );
        })}
      </div>
      {MEDIA_SOURCES.map((source) => {
        const selected = source === activeSource;
        return (
          <section
            key={source}
            id={`media-panel-${source}`}
            role="tabpanel"
            aria-labelledby={`media-tab-${source}`}
            tabIndex={selected ? 0 : -1}
            hidden={!selected}
          >
            {selected && source === "spotify" && <SpotifyPanel />}
            {selected && source === "audiobooks" && <AudiobookPanel />}
            {selected && source === "apple-music" && <AppleMusicPanel />}
          </section>
        );
      })}
    </div>
  );
}

export default MediaPage;