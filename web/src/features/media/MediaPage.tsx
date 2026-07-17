import {
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent,
} from "react";
import {
  BookOpen,
  Music,
  Pause,
  Play,
  RefreshCw,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { H2 } from "@nous-research/ui/ui/components/typography/h2";
import { api, buildAuthedAssetUrl } from "@/lib/api";
import type {
  AudiobookIndex,
  SpotifyMediaState,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  MEDIA_SOURCES,
  SOURCE_LABELS,
  moveMediaSourceFocus,
  type MediaNavigationKey,
  type MediaSource,
} from "./media-source";

function SpotifyPanel() {
  const [state, setState] = useState<SpotifyMediaState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setState(await api.getSpotifyMediaState());
    } catch {
      setError("Spotify playback state could not be loaded.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .getSpotifyMediaState()
      .then((result) => {
        if (!cancelled) setState(result);
      })
      .catch(() => {
        if (!cancelled) {
          setError("Spotify playback state could not be loaded.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const control = async (
    action: "play" | "pause" | "previous" | "next",
  ) => {
    setPending(true);
    setError(null);
    try {
      setState(
        await api.controlSpotifyMedia(
          action,
          state?.playback?.device?.id ?? undefined,
        ),
      );
    } catch {
      setError(`Spotify ${action} failed safely.`);
    } finally {
      setPending(false);
    }
  };

  const playback = state?.playback;
  const controlsEnabled = state?.status === "ready" && !pending;

  return (
    <Card>
      <CardContent className="space-y-5 py-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Spotify playback</h3>
            <p className="text-sm text-muted-foreground" role="status">
              {error ?? state?.message ?? "Loading Spotify playback…"}
            </p>
          </div>
          <Button ghost size="icon" onClick={() => void refresh()} aria-label="Refresh Spotify playback">
            <RefreshCw />
          </Button>
        </div>

        {playback?.item ? (
          <div>
            <p className="font-medium">{playback.item.name}</p>
            <p className="text-sm text-muted-foreground">
              {playback.item.artists.join(", ") || "Unknown artist"}
            </p>
            <p className="text-xs text-muted-foreground">
              {playback.device?.name
                ? `Playing on ${playback.device.name}`
                : "No device name available"}
            </p>
          </div>
        ) : null}

        <div className="flex items-center gap-2" aria-label="Spotify playback controls">
          <Button
            size="icon"
            onClick={() => void control("previous")}
            disabled={!controlsEnabled}
            aria-label="Spotify previous track"
          >
            <SkipBack />
          </Button>
          <Button
            size="icon"
            onClick={() => void control(playback?.is_playing ? "pause" : "play")}
            disabled={!controlsEnabled}
            aria-label={playback?.is_playing ? "Spotify pause" : "Spotify play"}
          >
            {playback?.is_playing ? <Pause /> : <Play />}
          </Button>
          <Button
            size="icon"
            onClick={() => void control("next")}
            disabled={!controlsEnabled}
            aria-label="Spotify next track"
          >
            <SkipForward />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function AudiobookPanel() {
  const [index, setIndex] = useState<AudiobookIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getAudiobookIndex()
      .then((result) => {
        if (cancelled) return;
        setIndex(result);
        setSelectedId(result.chapters[0]?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setError("The audiobook library could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = index?.chapters.find((chapter) => chapter.id === selectedId);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.7fr)]">
      <Card>
        <CardContent className="space-y-4 py-6">
          <div className="flex items-center gap-3">
            <BookOpen className="h-5 w-5" />
            <div>
              <h3 className="font-semibold">Your First Hundred Million</h3>
              <p className="text-sm text-muted-foreground" role="status">
                {error ??
                  (index
                    ? `${index.chapters.length} chapters available`
                    : "Loading audiobook chapters…")}
              </p>
            </div>
          </div>
          {selected ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">{selected.title}</p>
              <audio
                key={selected.id}
                className="w-full"
                controls
                preload="metadata"
                src={buildAuthedAssetUrl(selected.stream_url)}
              >
                Your browser does not support audio playback.
              </audio>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-4">
          <h3 className="mb-3 font-semibold">Chapters</h3>
          <ol className="max-h-[28rem] space-y-1 overflow-y-auto">
            {index?.chapters.map((chapter) => (
              <li key={chapter.id}>
                <button
                  type="button"
                  className={cn(
                    "w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted",
                    selectedId === chapter.id && "bg-muted font-medium",
                  )}
                  onClick={() => setSelectedId(chapter.id)}
                  aria-current={selectedId === chapter.id ? "true" : undefined}
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
          <h3 className="font-semibold">Apple Music</h3>
        </div>
        <p className="text-sm text-muted-foreground" role="status">
          Planned. MusicKit developer and user authorization must be configured before catalog or playback controls are enabled.
        </p>
      </CardContent>
    </Card>
  );
}

export function MediaPage({
  initialSource = "spotify",
}: {
  initialSource?: MediaSource;
}) {
  const [activeSource, setActiveSource] = useState<MediaSource>(initialSource);

  const onTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    source: MediaSource,
  ) => {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    const next = moveMediaSourceFocus(
      MEDIA_SOURCES,
      source,
      event.key as MediaNavigationKey,
    );
    setActiveSource(next);
    document.getElementById(`media-tab-${next}`)?.focus();
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
      <div>
        <H2>Media</H2>
        <p className="text-sm text-muted-foreground">
          Music and owned audio with direct controls. AI is optional, not required.
        </p>
      </div>

      <div
        role="tablist"
        aria-label="Media source"
        className="flex gap-1 overflow-x-auto border-b border-border"
      >
        {MEDIA_SOURCES.map((source) => {
          const selected = source === activeSource;
          return (
            <button
              key={source}
              id={`media-tab-${source}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`media-panel-${source}`}
              tabIndex={selected ? 0 : -1}
              className={cn(
                "min-h-11 whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium",
                selected
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setActiveSource(source)}
              onKeyDown={(event) => onTabKeyDown(event, source)}
            >
              {SOURCE_LABELS[source]}
            </button>
          );
        })}
      </div>

      <section
        id={`media-panel-${activeSource}`}
        role="tabpanel"
        aria-labelledby={`media-tab-${activeSource}`}
        tabIndex={0}
      >
        {activeSource === "spotify" ? <SpotifyPanel /> : null}
        {activeSource === "audiobooks" ? <AudiobookPanel /> : null}
        {activeSource === "apple-music" ? <AppleMusicPanel /> : null}
      </section>
    </div>
  );
}

export default MediaPage;
