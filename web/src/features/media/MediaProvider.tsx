import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Pause, Play, SkipBack, SkipForward, Volume2 } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";

import { useProfileScope } from "@/contexts/useProfileScope";
import {
  api,
  buildAuthedAssetUrl,
  type AudiobookChapter,
  type AudiobookIndex,
  type SpotifyMediaCommand,
  type SpotifyMediaItem,
  type SpotifyMediaState,
} from "@/lib/api";
import {
  createDeferredMediaStart,
  createLatestRequestGate,
  initialMediaState,
  mediaReducer,
  normalizeSpotifyProviderState,
  type MediaState,
  type NowPlaying,
} from "./media-state";

interface MediaContextValue {
  state: MediaState;
  spotify: SpotifyMediaState | null;
  audiobook: AudiobookIndex | null;
  selectedChapter: AudiobookChapter | null;
  audiobookRate: number;
  searchResults: SpotifyMediaItem[];
  searchPending: boolean;
  refreshSpotify(): Promise<void>;
  controlSpotify(command: SpotifyMediaCommand, optimisticPlaying?: boolean): Promise<void>;
  searchSpotify(query: string): Promise<void>;
  selectAudiobook(chapterId: string, autoplay?: boolean): void;
  setAudiobookRate(rate: number): void;
}

const noopAsync = async () => undefined;
const MediaContext = createContext<MediaContextValue>({
  state: initialMediaState,
  spotify: null,
  audiobook: null,
  selectedChapter: null,
  audiobookRate: 1,
  searchResults: [],
  searchPending: false,
  refreshSpotify: noopAsync,
  controlSpotify: noopAsync,
  searchSpotify: noopAsync,
  selectAudiobook: () => undefined,
  setAudiobookRate: () => undefined,
});

// Shared hook intentionally lives beside its provider to keep the media contract singular.
// eslint-disable-next-line react-refresh/only-export-components
export function useMedia(): MediaContextValue {
  return useContext(MediaContext);
}

function audiobookNowPlaying(
  chapter: AudiobookChapter,
  index: AudiobookIndex,
): NowPlaying {
  const resume = index.progress?.chapter_id === chapter.id ? index.progress : null;
  return {
    provider: "audiobook",
    id: chapter.id,
    title: chapter.title,
    subtitle: index.book,
    durationSeconds: resume?.duration_seconds ?? 0,
    positionSeconds: resume?.position_seconds ?? 0,
    isPlaying: false,
  };
}

export function MediaProvider({ children }: { children: ReactNode }) {
  const { profile } = useProfileScope();
  const [state, dispatch] = useReducer(mediaReducer, initialMediaState);
  const [spotify, setSpotify] = useState<SpotifyMediaState | null>(null);
  const [audiobook, setAudiobook] = useState<AudiobookIndex | null>(null);
  const [selectedChapter, setSelectedChapter] = useState<AudiobookChapter | null>(null);
  const [audiobookRate, setAudiobookRateValue] = useState(1);
  const [autoplayChapterId, setAutoplayChapterId] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<SpotifyMediaItem[]>([]);
  const [searchPending, setSearchPending] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const cancelDeferredRef = useRef<(() => void) | null>(null);
  const commandIdRef = useRef(0);
  const spotifyGateRef = useRef(createLatestRequestGate());
  const searchGateRef = useRef(createLatestRequestGate());
  const lastSavedSecondRef = useRef(-1);

  const refreshSpotify = useCallback(async () => {
    const requestId = spotifyGateRef.current.next();
    try {
      const value = await api.getSpotifyMediaState();
      if (!spotifyGateRef.current.isCurrent(requestId)) return;
      setSpotify(value);
      dispatch({ type: "spotify-loaded", value: normalizeSpotifyProviderState(value) });
    } catch {
      if (!spotifyGateRef.current.isCurrent(requestId)) return;
      dispatch({
        type: "spotify-failed",
        message: "Spotify playback could not be loaded. Retry when the connection is available.",
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setAudiobook(null);
      setSelectedChapter(null);
      dispatch({
        type: "audiobook-loaded",
        value: {
          provider: "audiobook",
          status: "loading",
          message: "Loading audiobook library…",
          nowPlaying: null,
        },
      });
      void refreshSpotify();
    });
    api.getAudiobookIndex().then((value) => {
      if (cancelled) return;
      setAudiobook(value);
      const selected = value.chapters.find(
        (chapter) => chapter.id === value.progress?.chapter_id,
      ) ?? value.chapters[0] ?? null;
      setSelectedChapter(selected);
      setAudiobookRateValue(value.progress?.playback_rate ?? 1);
      dispatch({
        type: "audiobook-loaded",
        value: {
          provider: "audiobook",
          status: selected ? "ready" : "empty",
          message: selected
            ? `${value.chapters.length} audiobook chapters available.`
            : "No audiobook chapters are available.",
          nowPlaying: selected ? audiobookNowPlaying(selected, value) : null,
        },
      });
    }).catch(() => {
      if (!cancelled) {
        dispatch({
          type: "audiobook-loaded",
          value: {
            provider: "audiobook",
            status: "error",
            message: "The audiobook library could not be loaded. Retry later.",
            nowPlaying: null,
          },
        });
      }
    });
    return () => {
      cancelled = true;
      cancelDeferredRef.current?.();
    };
  }, [profile, refreshSpotify]);

  const controlSpotify = useCallback(async (
    command: SpotifyMediaCommand,
    optimisticPlaying?: boolean,
  ) => {
    const commandId = ++commandIdRef.current;
    const requestId = spotifyGateRef.current.next();
    dispatch({ type: "command-started", commandId, optimisticPlaying });
    try {
      const value = await api.controlSpotifyMedia(command);
      if (!spotifyGateRef.current.isCurrent(requestId)) return;
      setSpotify(value);
      const normalized = normalizeSpotifyProviderState(value);
      if (value.status === "degraded" || value.status === "needs_auth") {
        dispatch({
          type: "command-rejected",
          commandId,
          message: `${value.message} The previous playback state was restored.`,
          providerState: normalized,
        });
        return;
      }
      dispatch({
        type: "command-resolved",
        commandId,
        value: normalized,
      });
    } catch {
      if (!spotifyGateRef.current.isCurrent(requestId)) return;
      dispatch({
        type: "command-rejected",
        commandId,
        message: "Playback command failed. The previous state was restored; try again.",
      });
    }
  }, []);

  const searchSpotify = useCallback(async (query: string) => {
    const trimmed = query.trim();
    const requestId = searchGateRef.current.next();
    if (!trimmed) {
      setSearchResults([]);
      setSearchPending(false);
      return;
    }
    setSearchPending(true);
    try {
      const value = await api.searchSpotifyMedia(trimmed, 20);
      if (searchGateRef.current.isCurrent(requestId)) {
        setSearchResults(value.items);
      }
    } catch {
      if (searchGateRef.current.isCurrent(requestId)) {
        setSearchResults([]);
        dispatch({
          type: "spotify-search-failed",
          message: "Spotify search failed. Check the connection and retry.",
        });
      }
    } finally {
      if (searchGateRef.current.isCurrent(requestId)) setSearchPending(false);
    }
  }, []);

  const selectAudiobook = useCallback((chapterId: string, autoplay = true) => {
    if (!audiobook) return;
    const chapter = audiobook.chapters.find((item) => item.id === chapterId);
    if (!chapter) return;
    cancelDeferredRef.current?.();
    setSelectedChapter(chapter);
    setAutoplayChapterId(autoplay ? chapter.id : null);
    dispatch({
      type: "now-playing",
      value: audiobookNowPlaying(chapter, audiobook),
      announcement: `Selected ${chapter.title}.`,
    });
  }, [audiobook]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !selectedChapter || !audiobook) return;
    cancelDeferredRef.current?.();
    if (autoplayChapterId === selectedChapter.id) {
      const resume = audiobook.progress?.chapter_id === selectedChapter.id
        ? audiobook.progress.position_seconds
        : 0;
      cancelDeferredRef.current = createDeferredMediaStart(audio, resume);
      audio.load();
    }
    return () => cancelDeferredRef.current?.();
  }, [audiobook, autoplayChapterId, selectedChapter]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = audiobookRate;
  }, [audiobookRate, selectedChapter]);

  const saveProgress = useCallback((audio: HTMLAudioElement, force = false) => {
    if (!selectedChapter || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const second = Math.floor(audio.currentTime);
    dispatch({ type: "position", value: audio.currentTime, isPlaying: !audio.paused });
    if (!force && (second === lastSavedSecondRef.current || second % 5 !== 0)) return;
    lastSavedSecondRef.current = second;
    void api.saveAudiobookProgress({
      chapter_id: selectedChapter.id,
      position_seconds: audio.currentTime,
      duration_seconds: audio.duration,
      playback_rate: audio.playbackRate,
    }).catch(() => undefined);
  }, [selectedChapter]);

  const nextAudiobookChapter = useCallback(() => {
    if (!audiobook || !selectedChapter) return;
    const index = audiobook.chapters.findIndex((chapter) => chapter.id === selectedChapter.id);
    const next = audiobook.chapters[index + 1];
    if (next) selectAudiobook(next.id, true);
  }, [audiobook, selectAudiobook, selectedChapter]);

  const setAudiobookRate = useCallback((rate: number) => {
    setAudiobookRateValue(rate);
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, []);

  const dockActive = state.nowPlaying !== null;
  useEffect(() => {
    if (!dockActive) {
      delete document.documentElement.dataset.mediaDock;
      return;
    }
    document.documentElement.dataset.mediaDock = "active";
    return () => {
      delete document.documentElement.dataset.mediaDock;
    };
  }, [dockActive]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !state.nowPlaying) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: state.nowPlaying.title,
      artist: state.nowPlaying.subtitle,
      album: state.nowPlaying.provider === "audiobook" ? "Audiobook" : "Spotify",
    });
    const setHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported */ }
    };
    setHandler("play", () => {
      if (state.nowPlaying?.provider === "audiobook") void audioRef.current?.play();
      else void controlSpotify({ action: "play" }, true);
    });
    setHandler("pause", () => {
      if (state.nowPlaying?.provider === "audiobook") audioRef.current?.pause();
      else void controlSpotify({ action: "pause" }, false);
    });
    setHandler("nexttrack", state.nowPlaying.provider === "audiobook"
      ? nextAudiobookChapter
      : () => void controlSpotify({ action: "next" }));
    setHandler("previoustrack", state.nowPlaying.provider === "spotify"
      ? () => void controlSpotify({ action: "previous" })
      : null);
    return () => {
      setHandler("play", null);
      setHandler("pause", null);
      setHandler("nexttrack", null);
      setHandler("previoustrack", null);
    };
  }, [controlSpotify, nextAudiobookChapter, state.nowPlaying]);

  const context = useMemo<MediaContextValue>(() => ({
    state,
    spotify,
    audiobook,
    selectedChapter,
    audiobookRate,
    searchResults,
    searchPending,
    refreshSpotify,
    controlSpotify,
    searchSpotify,
    selectAudiobook,
    setAudiobookRate,
  }), [
    audiobook, audiobookRate, controlSpotify, refreshSpotify, searchPending, searchResults,
    searchSpotify, selectAudiobook, selectedChapter, setAudiobookRate, spotify, state,
  ]);

  return (
    <MediaContext.Provider value={context}>
      {children}
      <PlayerDockView
        state={state}
        spotify={spotify}
        audioRef={audioRef}
        selectedChapter={selectedChapter}
        onControlSpotify={controlSpotify}
        onNextAudiobook={nextAudiobookChapter}
        onTimeUpdate={saveProgress}
      />
    </MediaContext.Provider>
  );
}

interface PlayerDockProps {
  state: MediaState;
  spotify: SpotifyMediaState | null;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  selectedChapter: AudiobookChapter | null;
  onControlSpotify(command: SpotifyMediaCommand, optimisticPlaying?: boolean): Promise<void>;
  onNextAudiobook(): void;
  onTimeUpdate(audio: HTMLAudioElement, force?: boolean): void;
}

export function PlayerDockView({
  state,
  spotify,
  audioRef,
  selectedChapter,
  onControlSpotify,
  onNextAudiobook,
  onTimeUpdate,
}: PlayerDockProps) {
  const playing = state.nowPlaying;
  if (!playing) return null;
  const spotifyDevice = spotify?.playback?.device?.id ?? undefined;
  const isAudiobook = playing.provider === "audiobook";
  return (
    <section
      aria-label="Persistent media player"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-midground/30 bg-background-base/95 px-3 pb-[calc(.5rem+env(safe-area-inset-bottom,0px))] pt-2 shadow-2xl backdrop-blur lg:left-64"
    >
      <div className="mx-auto flex max-w-5xl items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{playing.title}</p>
          <p className="truncate text-xs text-text-secondary">{playing.subtitle}</p>
        </div>
        <div className="flex items-center gap-1" aria-label={`${playing.provider} player controls`}>
          {!isAudiobook && (
            <Button className="min-h-11 min-w-11" size="icon" ghost aria-label="Previous track" onClick={() => void onControlSpotify({ action: "previous", device_id: spotifyDevice })}>
              <SkipBack />
            </Button>
          )}
          <Button
            className="min-h-11 min-w-11"
            size="icon"
            aria-label={playing.isPlaying ? "Pause media" : "Play media"}
            onClick={() => {
              if (isAudiobook) {
                const audio = audioRef.current;
                if (!audio) return;
                if (audio.paused) void audio.play(); else audio.pause();
              } else {
                void onControlSpotify({
                  action: playing.isPlaying ? "pause" : "play",
                  device_id: spotifyDevice,
                }, !playing.isPlaying);
              }
            }}
          >
            {playing.isPlaying ? <Pause /> : <Play />}
          </Button>
          <Button className="min-h-11 min-w-11" size="icon" ghost aria-label={isAudiobook ? "Next chapter" : "Next track"} onClick={() => {
            if (isAudiobook) onNextAudiobook();
            else void onControlSpotify({ action: "next", device_id: spotifyDevice });
          }}>
            <SkipForward />
          </Button>
        </div>
        {playing.durationSeconds > 0 && (
          <label className="flex min-w-20 flex-1 items-center gap-2 md:min-w-32">
            <span className="sr-only">Seek {isAudiobook ? "chapter" : "track"}</span>
            <input
              aria-label={`Seek ${isAudiobook ? "chapter" : "track"}`}
              className="w-full"
              type="range"
              min="0"
              max={Math.max(1, playing.durationSeconds)}
              value={Math.min(playing.positionSeconds, playing.durationSeconds)}
              onChange={(event) => {
                const seconds = Number(event.currentTarget.value);
                if (isAudiobook && audioRef.current) {
                  audioRef.current.currentTime = seconds;
                  onTimeUpdate(audioRef.current);
                } else {
                  void onControlSpotify({
                    action: "seek",
                    position_ms: Math.round(seconds * 1000),
                    device_id: spotifyDevice,
                  });
                }
              }}
            />
          </label>
        )}
        {!isAudiobook && spotify?.capabilities.volume && (
          <label className="hidden items-center gap-2 sm:flex">
            <Volume2 className="h-4 w-4" aria-hidden />
            <span className="sr-only">Spotify volume</span>
            <input
              aria-label="Spotify volume"
              type="range"
              min="0"
              max="100"
              defaultValue={spotify.playback?.device?.volume_percent ?? 50}
              onChange={(event) => void onControlSpotify({
                action: "volume",
                volume_percent: Number(event.currentTarget.value),
                device_id: spotifyDevice,
              })}
            />
          </label>
        )}
        {isAudiobook && selectedChapter && (
          <audio
            className="hidden"
            ref={audioRef}
            src={buildAuthedAssetUrl(selectedChapter.stream_url)}
            preload="metadata"
            onPlay={(event) => onTimeUpdate(event.currentTarget)}
            onPause={(event) => onTimeUpdate(event.currentTarget, true)}
            onTimeUpdate={(event) => onTimeUpdate(event.currentTarget)}
            onEnded={(event) => {
              onTimeUpdate(event.currentTarget, true);
              onNextAudiobook();
            }}
          >
            Your browser does not support audio playback.
          </audio>
        )}
      </div>
      <p className="sr-only" aria-live="polite">{state.announcement}</p>
    </section>
  );
}
