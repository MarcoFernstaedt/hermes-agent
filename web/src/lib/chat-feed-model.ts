import type { SessionMessage } from "@/lib/api";

export type ChatFeedRole =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "approval"
  | "write_approval"
  | "clarify";

export type ChatFeedStatus =
  | "sending"
  | "sent"
  | "streaming"
  | "running"
  | "waiting"
  | "error";

export interface ChatFeedMessage {
  id: string;
  role: ChatFeedRole;
  text: string;
  title?: string;
  status: ChatFeedStatus;
  timestamp: number;
  raw?: unknown;
  rawText?: string;
  allowPermanent?: boolean;
  resolution?: string;
  choices?: string[];
  requestId?: string;
  pendingId?: string;
  subsystem?: "memory" | "skills";
  profile?: string;
  eventId?: string;
}

export interface ChatFeedState {
  messages: ChatFeedMessage[];
  activeAssistantId: string | null;
  activeApprovalId: string | null;
  activeClarifyId: string | null;
}

export interface ChatFeedEvent {
  type: string;
  payload?: Record<string, unknown>;
  sessionId?: string | null;
  eventId?: string;
  now?: number;
}

const textValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const firstText = (...values: unknown[]): string => {
  for (const value of values) {
    const text = textValue(value);
    if (text) return text;
  }
  return "";
};

export const writeApprovalKey = (
  profile: string,
  subsystem: "memory" | "skills",
  pendingId: string,
): string => `${profile}:${subsystem}:${pendingId}`;

const withoutMediaDeliveryPaths = (text: string): string =>
  text
    .split(/\r?\n/)
    .filter((line) => !/^\s*MEDIA\s*:/i.test(line))
    .join("\n")
    .trimEnd();

const replaceMessage = (
  messages: ChatFeedMessage[],
  id: string,
  update: (message: ChatFeedMessage) => ChatFeedMessage,
): ChatFeedMessage[] =>
  messages.map((message) => (message.id === id ? update(message) : message));

const acknowledgeLatestUser = (messages: ChatFeedMessage[]): ChatFeedMessage[] => {
  const index = [...messages]
    .reverse()
    .findIndex(
      (message) =>
        message.role === "user" &&
        (message.status === "sending" || message.status === "waiting"),
    );
  if (index < 0) return messages;
  const actualIndex = messages.length - 1 - index;
  return messages.map((message, messageIndex) =>
    messageIndex === actualIndex ? { ...message, status: "sent" } : message,
  );
};

export function createOptimisticUserMessage(
  text: string,
  id: string,
  timestamp = Date.now(),
): ChatFeedMessage {
  return {
    id,
    role: "user",
    text,
    status: "sending",
    timestamp,
  };
}

export function hydrateSessionMessages(messages: SessionMessage[]): ChatFeedMessage[] {
  return messages.map((message, index) => ({
    id: `history-${message.timestamp ?? "untimed"}-${index}`,
    role: message.role,
    text:
      message.role === "assistant"
        ? withoutMediaDeliveryPaths(message.content ?? "")
        : message.content ?? "",
    title:
      message.role === "tool"
        ? message.tool_name || "tool output"
        : message.role === "system"
          ? "system"
          : undefined,
    status: "sent",
    timestamp: message.timestamp ?? index,
    raw: message,
  }));
}

const normalizedTimestamp = (timestamp: number): number =>
  timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;

const hydrationRowsOverlap = (
  stored: ChatFeedMessage,
  live: ChatFeedMessage,
): boolean => {
  if (stored.role !== live.role) return false;
  if (Math.abs(normalizedTimestamp(stored.timestamp) - normalizedTimestamp(live.timestamp)) > 1_000) {
    return false;
  }

  const storedText = stored.text.trim();
  const liveText = live.text.trim();
  if (!storedText || !liveText) return false;
  if (storedText === liveText) return true;
  return (
    live.role === "assistant" &&
    live.status === "streaming" &&
    storedText.startsWith(liveText)
  );
};

const completedDurableUserIndexes = (
  history: ChatFeedMessage[],
): Map<string, number[]> => {
  const completed = new Map<string, number[]>();
  for (let index = 0; index < history.length; index += 1) {
    const stored = history[index];
    if (stored.role !== "user") continue;
    let hasCompletion = false;
    for (let turnIndex = index + 1; turnIndex < history.length; turnIndex += 1) {
      if (history[turnIndex].role === "user") break;
      if (history[turnIndex].role === "assistant") {
        hasCompletion = true;
        break;
      }
    }
    const text = stored.text.trim();
    if (!hasCompletion || !text) continue;
    const indexes = completed.get(text) ?? [];
    indexes.push(index);
    completed.set(text, indexes);
  }
  return completed;
};

const claimCompletedDurableTurn = (
  history: ChatFeedMessage[],
  completed: Map<string, number[]>,
  claimed: Set<number>,
  live: ChatFeedMessage,
  requireTimestampMatch: boolean,
): boolean => {
  if (live.role !== "user") return false;
  const candidates = completed.get(live.text.trim()) ?? [];
  for (const index of candidates) {
    if (claimed.has(index)) continue;
    if (requireTimestampMatch) {
      const raw = history[index].raw;
      const rawTimestamp =
        raw && typeof raw === "object"
          ? (raw as { timestamp?: unknown }).timestamp
          : undefined;
      // Text alone cannot distinguish a missed completion from a newly queued
      // repeated prompt. Ambiguous timestamp-less rows must remain pending.
      if (typeof rawTimestamp !== "number") continue;
      if (
        Math.abs(
          normalizedTimestamp(rawTimestamp) - normalizedTimestamp(live.timestamp),
        ) > 1_000
      ) {
        continue;
      }
    }
    claimed.add(index);
    return true;
  }
  return false;
};

export function mergeHydratedFeedState(
  history: ChatFeedMessage[],
  state: ChatFeedState,
): ChatFeedState {
  const completed = completedDurableUserIndexes(history);
  const claimedCompleted = new Set<number>();
  // Durable/history rows and already-acknowledged local user rows consume their
  // matching completed turns before optimistic rows are considered. This keeps
  // a second identical queued prompt distinct from the first completed turn.
  for (const message of state.messages) {
    if (
      message.role === "user" &&
      message.status !== "sending" &&
      message.status !== "waiting"
    ) {
      claimCompletedDurableTurn(
        history,
        completed,
        claimedCompleted,
        message,
        false,
      );
    }
  }
  const live = state.messages.filter((message) => {
    if (message.id.startsWith("history-")) return false;
    if (
      (message.status === "sending" || message.status === "waiting") &&
      claimCompletedDurableTurn(
        history,
        completed,
        claimedCompleted,
        message,
        true,
      )
    ) {
      return false;
    }
    return true;
  });
  let overlap = 0;
  let historyStart = history.length;
  const maximum = Math.min(history.length, live.length);

  outer: for (let size = maximum; size > 0; size -= 1) {
    for (let start = history.length - size; start >= 0; start -= 1) {
      if (
        live.slice(0, size).every((message, index) =>
          hydrationRowsOverlap(history[start + index], message),
        )
      ) {
        overlap = size;
        historyStart = start;
        break outer;
      }
    }
  }

  const activeIds = new Set(
    [state.activeAssistantId, state.activeApprovalId, state.activeClarifyId].filter(
      (id): id is string => Boolean(id),
    ),
  );
  const reconciledOverlap = live.slice(0, overlap).map((message, index) =>
    ((activeIds.has(message.id) || message.status === "streaming") &&
      message.role !== "assistant") ||
    message.status === "running" ||
    message.status === "waiting"
      ? message
      : history[historyStart + index],
  );
  const messages = [
    ...history.slice(0, historyStart),
    ...reconciledOverlap,
    ...history.slice(historyStart + overlap),
    ...live.slice(overlap),
  ];
  const retainedIds = new Set(messages.map((message) => message.id));

  return {
    ...state,
    messages,
    activeAssistantId:
      state.activeAssistantId && retainedIds.has(state.activeAssistantId)
        ? state.activeAssistantId
        : null,
    activeApprovalId:
      state.activeApprovalId && retainedIds.has(state.activeApprovalId)
        ? state.activeApprovalId
        : null,
    activeClarifyId:
      state.activeClarifyId && retainedIds.has(state.activeClarifyId)
        ? state.activeClarifyId
        : null,
  };
}

export function shouldHandleChannelEvent(
  effectGeneration: number,
  currentGeneration: number,
  unmounting: boolean,
): boolean {
  return !unmounting && effectGeneration === currentGeneration;
}

export function shouldApplyHydration(
  requestGeneration: number,
  currentGeneration: number,
  requestSessionId: string,
  currentSessionId: string | null,
): boolean {
  return (
    requestGeneration === currentGeneration &&
    requestSessionId === currentSessionId
  );
}

export function approvalChoiceKey(
  choice: "once" | "session" | "always" | "deny",
  allowPermanent: boolean,
): string {
  const choices = allowPermanent
    ? (["once", "session", "always", "deny"] as const)
    : (["once", "session", "deny"] as const);
  const index = choices.indexOf(choice as never);
  if (index < 0) throw new Error(`Approval choice ${choice} is not available`);
  return String(index + 1);
}

export function shouldShowSlashCommands(input: string): boolean {
  return input.startsWith("/") && !input.includes("\n");
}

export function getChatWelcome(now = new Date()): {
  greeting: string;
  prompt: string;
} {
  const hour = now.getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return { greeting, prompt: "What should we get started on today?" };
}

export function parseDashboardEventFrame(
  raw: string,
  now = Date.now(),
): ChatFeedEvent | null {
  try {
    const frame = JSON.parse(raw) as {
      method?: unknown;
      session_id?: unknown;
      params?: {
        type?: unknown;
        payload?: unknown;
        session_id?: unknown;
        event_id?: unknown;
      };
    };
    if (frame.method !== "event" || typeof frame.params?.type !== "string") {
      return null;
    }
    const payload =
      frame.params.payload && typeof frame.params.payload === "object"
        ? (frame.params.payload as Record<string, unknown>)
        : {};
    const rawSessionId = frame.params.session_id ?? frame.session_id;
    return {
      type: frame.params.type,
      sessionId: typeof rawSessionId === "string" ? rawSessionId : null,
      eventId:
        typeof frame.params.event_id === "string" ? frame.params.event_id : undefined,
      payload,
      now,
    };
  } catch {
    return null;
  }
}

export function chatFeedReducer(
  state: ChatFeedState,
  event: ChatFeedEvent,
): ChatFeedState {
  const payload = event.payload ?? {};
  const now = event.now ?? Date.now();

  if (event.type === "message.start") {
    const id = state.activeAssistantId ?? `assistant-${now}`;
    const messages = acknowledgeLatestUser(state.messages);
    return {
      ...state,
      messages: messages.some((message) => message.id === id)
        ? messages
        : [
            ...messages,
            {
              id,
              role: "assistant",
              text: "",
              status: "streaming",
              timestamp: now,
            },
          ],
      activeAssistantId: id,
    };
  }

  // Reasoning is intentionally omitted from the semantic feed. The native
  // terminal remains authoritative and applies its own visibility policy;
  // merging reasoning into answer text could disclose private intermediates.
  if (event.type === "reasoning.delta") return state;

  if (event.type === "message.delta") {
    const delta = textValue(payload.text);
    if (!delta) return state;
    const id = state.activeAssistantId ?? `assistant-${now}`;
    const existing = state.messages.some((message) => message.id === id);
    const messages = existing
      ? replaceMessage(state.messages, id, (message) => {
          const rawText = (message.rawText ?? message.text) + delta;
          return {
            ...message,
            text: withoutMediaDeliveryPaths(rawText),
            rawText,
            status: "streaming",
          };
        })
      : [
          ...acknowledgeLatestUser(state.messages),
          {
            id,
            role: "assistant" as const,
            text: withoutMediaDeliveryPaths(delta),
            rawText: delta,
            status: "streaming" as const,
            timestamp: now,
          },
        ];
    return { ...state, messages, activeAssistantId: id };
  }

  if (event.type === "message.complete") {
    const finalText = firstText(payload.text, payload.rendered);
    const visibleFinalText = withoutMediaDeliveryPaths(finalText);
    const id = state.activeAssistantId;
    if (
      event.eventId &&
      state.messages.some((message) => message.eventId === event.eventId)
    ) {
      return state;
    }
    const messages = id
      ? replaceMessage(state.messages, id, (message) => ({
          ...message,
          text: withoutMediaDeliveryPaths(finalText || message.rawText || message.text),
          rawText: undefined,
          status: "sent",
          eventId: event.eventId,
        }))
      : finalText
        ? [
            ...acknowledgeLatestUser(state.messages),
            {
              id: `assistant-${event.eventId ?? now}`,
              role: "assistant" as const,
              text: visibleFinalText,
              status: "sent" as const,
              timestamp: now,
              eventId: event.eventId,
            },
          ]
        : acknowledgeLatestUser(state.messages);
    return {
      ...state,
      messages,
      activeAssistantId: null,
      activeApprovalId: null,
      activeClarifyId: null,
    };
  }

  if (
    event.type === "tool.start" ||
    event.type === "tool.progress" ||
    event.type === "tool.generating" ||
    event.type === "tool.complete"
  ) {
    const toolId = firstText(
      payload.tool_id,
      payload.tool_call_id,
      payload.id,
      `${firstText(payload.name, "tool")}-${now}`,
    );
    const id = `tool-${toolId}`;
    const complete = event.type === "tool.complete";
    const title = firstText(payload.name, "tool");
    const text = complete
      ? firstText(payload.result, payload.output, payload.preview, payload.error)
      : firstText(payload.preview, payload.message, payload.args, payload.input);
    const next: ChatFeedMessage = {
      id,
      role: "tool",
      title,
      text,
      status: payload.error ? "error" : complete ? "sent" : "running",
      timestamp: now,
      raw: payload,
    };
    const messages = state.messages.some((message) => message.id === id)
      ? replaceMessage(state.messages, id, (message) => ({
          ...message,
          ...next,
          text: next.text || message.text,
          timestamp: message.timestamp,
        }))
      : [...state.messages, next];
    return { ...state, messages };
  }

  if (event.type === "approval.request") {
    const id = `approval-${now}`;
    const message: ChatFeedMessage = {
      id,
      role: "approval",
      title: firstText(payload.description, "Approval required"),
      text: firstText(payload.command, payload.description),
      status: "waiting",
      timestamp: now,
      allowPermanent: payload.allow_permanent !== false,
      raw: payload,
    };
    return {
      ...state,
      messages: [...state.messages, message],
      activeApprovalId: id,
    };
  }

  if (event.type === "approval.resolved" && state.activeApprovalId) {
    const resolution = firstText(payload.choice, "resolved");
    return {
      ...state,
      messages: replaceMessage(
        state.messages,
        state.activeApprovalId,
        (message) => ({ ...message, status: "sent", resolution }),
      ),
      activeApprovalId: null,
    };
  }

  if (event.type === "write_approval.request") {
    const pendingId = firstText(payload.pending_id);
    if (!pendingId) return state;
    if (payload.subsystem !== "memory" && payload.subsystem !== "skills") return state;
    const subsystem = payload.subsystem;
    const profile = firstText(payload.profile, "current");
    const key = writeApprovalKey(profile, subsystem, pendingId);
    const id = `write-approval-${encodeURIComponent(key)}`;
    const next: ChatFeedMessage = {
      id,
      role: "write_approval",
      title: "Approval required",
      text:
        firstText(payload.summary) ||
        `${subsystem === "memory" ? "Memory" : "Skill"} change staged for review`,
      status: "waiting",
      timestamp: now,
      pendingId,
      subsystem,
      profile,
    };
    const messages = state.messages.some((message) => message.id === id)
      ? replaceMessage(state.messages, id, (message) => ({
          ...message,
          ...next,
          status: message.status,
          resolution: message.resolution,
          timestamp: message.timestamp,
        }))
      : [...state.messages, next];
    return { ...state, messages };
  }

  if (event.type === "write_approval.resolved") {
    const pendingId = firstText(payload.pending_id);
    if (
      !pendingId ||
      (payload.subsystem !== "memory" && payload.subsystem !== "skills")
    ) return state;
    const profile = firstText(payload.profile, "current");
    const key = writeApprovalKey(profile, payload.subsystem, pendingId);
    return {
      ...state,
      messages: state.messages.map((message) =>
        message.pendingId && message.subsystem && message.profile &&
        writeApprovalKey(message.profile, message.subsystem, message.pendingId) === key
          ? {
              ...message,
              status: "sent" as const,
              resolution: firstText(payload.decision, "resolved"),
            }
          : message,
      ),
    };
  }

  if (event.type === "write_approval.submitting" || event.type === "write_approval.failed") {
    const pendingId = firstText(payload.pending_id);
    if (
      !pendingId ||
      (payload.subsystem !== "memory" && payload.subsystem !== "skills")
    ) return state;
    const profile = firstText(payload.profile, "current");
    const key = writeApprovalKey(profile, payload.subsystem, pendingId);
    const failed = event.type === "write_approval.failed";
    return {
      ...state,
      messages: state.messages.map((message) =>
        message.pendingId && message.subsystem && message.profile &&
        writeApprovalKey(message.profile, message.subsystem, message.pendingId) === key &&
        (failed ? message.status === "running" : message.status === "waiting")
          ? {
              ...message,
              status: failed ? ("waiting" as const) : ("running" as const),
            }
          : message,
      ),
    };
  }

  if (event.type === "clarify.request") {
    const id = `clarify-${firstText(payload.request_id, now)}`;
    const choices = Array.isArray(payload.choices)
      ? payload.choices.filter((choice): choice is string => typeof choice === "string")
      : [];
    const message: ChatFeedMessage = {
      id,
      role: "clarify",
      title: "Input requested",
      text: firstText(payload.question, "The agent needs input."),
      status: "waiting",
      timestamp: now,
      choices,
      requestId: firstText(payload.request_id),
      raw: payload,
    };
    return {
      ...state,
      messages: [...state.messages, message],
      activeClarifyId: id,
    };
  }

  if (event.type === "clarify.resolved" && state.activeClarifyId) {
    return {
      ...state,
      messages: replaceMessage(
        state.messages,
        state.activeClarifyId,
        (message) => ({
          ...message,
          status: "sent",
          resolution: firstText(payload.answer, "answered"),
        }),
      ),
      activeClarifyId: null,
    };
  }

  if (event.type === "error") {
    const text = firstText(payload.message, payload.error, "Imperator reported an error");
    const id = state.activeAssistantId;
    const messages = id
      ? replaceMessage(state.messages, id, (message) => ({
          ...message,
          text: message.text || text,
          status: "error",
        }))
      : [
          ...state.messages,
          {
            id: `error-${now}`,
            role: "system" as const,
            title: "Error",
            text,
            status: "error" as const,
            timestamp: now,
          },
        ];
    return { ...state, messages, activeAssistantId: null };
  }

  const visibleOperationalEvents = new Set([
    "background.complete",
    "browser.progress",
    "review.summary",
    "status.update",
    "tool.output_risk",
    "voice.status",
    "voice.transcript",
  ]);
  if (visibleOperationalEvents.has(event.type)) {
    const text = firstText(
      payload.text,
      payload.message,
      payload.summary,
      payload.transcript,
      payload.status,
      payload,
    );
    if (text) {
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: `event-${event.type}-${now}`,
            role: "system",
            title: event.type,
            text,
            status: "sent",
            timestamp: now,
            raw: payload,
          },
        ],
      };
    }
  }

  return state;
}
