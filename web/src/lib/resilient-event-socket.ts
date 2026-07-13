export interface EventSocketFailure {
  code: number | null;
  error: unknown | null;
}

export function isTerminalDashboardEventFailure(
  failure: EventSocketFailure,
): boolean {
  if (failure.code === 4401 || failure.code === 4403) return true;
  return (
    failure.error instanceof Error &&
    /\/api\/auth\/ws-ticket: HTTP (?:401|403)\b/.test(failure.error.message)
  );
}

export interface ResilientEventSocketOptions {
  buildUrl(): Promise<string>;
  socketFactory?(url: string): WebSocket;
  onMessage(event: MessageEvent): void;
  onConnected(reconnected: boolean): void;
  onDisconnected(code: number | null): void;
  isTerminalFailure?(failure: EventSocketFailure): boolean;
  onTerminalFailure?(failure: EventSocketFailure): void;
  initialDelayMs?: number;
  maxDelayMs?: number;
  watchdogMs?: number;
}

/**
 * Maintain the dashboard's semantic event projection across browser sleep,
 * radio handoffs, proxy restarts, expiring tickets, and half-open sockets.
 * A fresh URL is minted for every attempt; stop() invalidates async attempts.
 */
export function connectResilientEventSocket(
  options: ResilientEventSocketOptions,
): () => void {
  const socketFactory = options.socketFactory ?? ((url: string) => new WebSocket(url));
  const initialDelayMs = Math.max(1, options.initialDelayMs ?? 250);
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? 3_000);
  const watchdogMs = Math.max(1, options.watchdogMs ?? 30_000);

  let stopped = false;
  let terminalFailure = false;
  let generation = 0;
  let attempt = 0;
  let everConnected = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  const clearWatchdog = () => {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  };

  const scheduleReconnect = (failure: EventSocketFailure) => {
    if (stopped || terminalFailure || retryTimer) return;
    clearWatchdog();
    options.onDisconnected(failure.code);
    if (options.isTerminalFailure?.(failure)) {
      terminalFailure = true;
      generation += 1;
      options.onTerminalFailure?.(failure);
      return;
    }
    const delay = Math.min(initialDelayMs * 2 ** attempt, maxDelayMs);
    attempt = Math.min(attempt + 1, 16);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delay);
  };

  const armWatchdog = (thisGeneration: number, candidate: WebSocket | null) => {
    clearWatchdog();
    watchdogTimer = setTimeout(() => {
      if (stopped || terminalFailure || thisGeneration !== generation) return;
      generation += 1;
      if (socket === candidate) socket = null;
      try {
        candidate?.close();
      } catch {
        // Invalidating the generation is authoritative.
      }
      scheduleReconnect({ code: null, error: null });
    }, watchdogMs);
  };

  const connect = async () => {
    if (stopped || terminalFailure) return;
    const thisGeneration = ++generation;
    armWatchdog(thisGeneration, null);
    try {
      const url = await options.buildUrl();
      if (stopped || terminalFailure || thisGeneration !== generation) return;

      const candidate = socketFactory(url);
      socket = candidate;
      armWatchdog(thisGeneration, candidate);
      candidate.addEventListener("open", () => {
        if (
          stopped ||
          terminalFailure ||
          socket !== candidate ||
          thisGeneration !== generation
        ) {
          return;
        }
        const reconnected = everConnected;
        everConnected = true;
        attempt = 0;
        armWatchdog(thisGeneration, candidate);
        options.onConnected(reconnected);
      });
      candidate.addEventListener("message", (event) => {
        if (
          stopped ||
          terminalFailure ||
          socket !== candidate ||
          thisGeneration !== generation
        ) {
          return;
        }
        armWatchdog(thisGeneration, candidate);
        options.onMessage(event as MessageEvent);
      });
      candidate.addEventListener("close", (event) => {
        if (stopped || socket !== candidate || thisGeneration !== generation) return;
        socket = null;
        scheduleReconnect({
          code: (event as CloseEvent).code || null,
          error: null,
        });
      });
      candidate.addEventListener("error", () => {
        if (stopped || socket !== candidate || thisGeneration !== generation) return;
        socket = null;
        try {
          candidate.close();
        } catch {
          // Scheduling below is authoritative even when close() itself fails.
        }
        scheduleReconnect({ code: null, error: null });
      });
    } catch (error) {
      if (stopped || terminalFailure || thisGeneration !== generation) return;
      socket = null;
      scheduleReconnect({ code: null, error });
    }
  };

  void connect();

  return () => {
    if (stopped) return;
    stopped = true;
    generation += 1;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    clearWatchdog();
    const current = socket;
    socket = null;
    try {
      current?.close();
    } catch {
      // The channel is already invalidated; nothing else may reconnect it.
    }
  };
}
