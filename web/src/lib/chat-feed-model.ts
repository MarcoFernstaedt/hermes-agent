import type { SessionMessage } from "@/lib/api";

export type ChatFeedRole =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "approval"
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
  allowPermanent?: boolean;
  resolution?: string;
  choices?: string[];
  requestId?: string;
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
    text: message.content ?? "",
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

export function mergeHydratedFeedState(
  history: ChatFeedMessage[],
  state: ChatFeedState,
): ChatFeedState {
  const live = state.messages.filter((message) => !message.id.startsWith("history-"));
  let overlap = 0;
  const maximum = Math.min(history.length, live.length);

  for (let size = maximum; size > 0; size -= 1) {
    const historyStart = history.length - size;
    if (
      live.slice(0, size).every((message, index) =>
        hydrationRowsOverlap(history[historyStart + index], message),
      )
    ) {
      overlap = size;
      break;
    }
  }

  const historyStart = history.length - overlap;
  const activeIds = new Set(
    [state.activeAssistantId, state.activeApprovalId, state.activeClarifyId].filter(
      (id): id is string => Boolean(id),
    ),
  );
  const reconciledOverlap = live.slice(0, overlap).map((message, index) =>
    activeIds.has(message.id) ||
    message.status === "streaming" ||
    message.status === "running" ||
    message.status === "waiting"
      ? message
      : history[historyStart + index],
  );
  const messages = [
    ...history.slice(0, historyStart),
    ...reconciledOverlap,
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
      ? replaceMessage(state.messages, id, (message) => ({
          ...message,
          text: message.text + delta,
          status: "streaming",
        }))
      : [
          ...acknowledgeLatestUser(state.messages),
          {
            id,
            role: "assistant" as const,
            text: delta,
            status: "streaming" as const,
            timestamp: now,
          },
        ];
    return { ...state, messages, activeAssistantId: id };
  }

  if (event.type === "message.complete") {
    const finalText = firstText(payload.text, payload.rendered);
    const id = state.activeAssistantId;
    const messages = id
      ? replaceMessage(state.messages, id, (message) => ({
          ...message,
          text: finalText || message.text,
          status: "sent",
        }))
      : finalText
        ? [
            ...acknowledgeLatestUser(state.messages),
            {
              id: `assistant-${now}`,
              role: "assistant" as const,
              text: finalText,
              status: "sent" as const,
              timestamp: now,
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
    const text = firstText(payload.message, payload.error, "Hermes reported an error");
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
