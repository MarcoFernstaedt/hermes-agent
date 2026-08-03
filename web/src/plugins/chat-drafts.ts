export const CHAT_DRAFT_LIMITS = {
  maxDrafts: 5,
  maxTitle: 300,
  maxContext: 6_000,
  maxRequest: 4_000,
  maxLifetimeMs: 10 * 60_000,
} as const;

export type ChatDraftKind = "page" | "selection" | "link" | "image";

export interface ChatDraftPayload {
  id: string;
  nonce: string;
  kind: ChatDraftKind;
  title: string;
  sourceUrl: string;
  sourceUrlRedacted: boolean;
  queryDataPresent: boolean;
  context: string;
  handoffOrigin: string;
  createdAt: number;
  expiresAt: number;
}

export interface ChatDraft extends ChatDraftPayload {
  acknowledged: boolean;
  state:
    | "pending"
    | "acknowledged"
    | "inserted-unknown"
    | "submitted-unknown"
    | "failed";
}

export interface ChatDraftRegistry {
  openDraft(payload: ChatDraftPayload): ChatDraft;
  subscribe(listener: (drafts: readonly ChatDraft[]) => void): () => void;
  get(id: string): ChatDraft | null;
  acknowledge(id: string): boolean;
  markInserted(id: string): boolean;
  markInsertionFailed(id: string): boolean;
  markSubmissionUnknown(id: string): boolean;
  markSubmissionFailed(id: string): boolean;
  clear(id: string): boolean;
  clearAll(): number;
  list(): readonly ChatDraft[];
}

interface RegistryOptions {
  expectedHandoffOrigin: string;
  now?: () => number;
}

const DRAFT_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const NONCE_RE = /^[A-Fa-f0-9]{32,128}$/;
const KINDS = new Set<ChatDraftKind>(["page", "selection", "link", "image"]);
const MAX_FUTURE_SKEW_MS = 30_000;
const encoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function hasUnsafeControls(value: string, allowLineFeed: boolean): boolean {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (allowLineFeed && point === 10) continue;
    if (point < 32 || (point >= 127 && point <= 159)) return true;
  }
  return false;
}

function samePayload(draft: ChatDraft, payload: ChatDraftPayload): boolean {
  return (
    draft.id === payload.id &&
    draft.nonce === payload.nonce &&
    draft.kind === payload.kind &&
    draft.title === payload.title &&
    draft.sourceUrl === payload.sourceUrl &&
    draft.sourceUrlRedacted === payload.sourceUrlRedacted &&
    draft.queryDataPresent === payload.queryDataPresent &&
    draft.context === payload.context &&
    draft.handoffOrigin === payload.handoffOrigin &&
    draft.createdAt === payload.createdAt &&
    draft.expiresAt === payload.expiresAt
  );
}

function validatePayload(
  payload: ChatDraftPayload,
  expectedHandoffOrigin: string,
  now: number,
): void {
  if (payload.handoffOrigin !== expectedHandoffOrigin) {
    throw new Error("chat draft handoff origin does not match this Dashboard");
  }
  if (!DRAFT_ID_RE.test(payload.id)) throw new Error("chat draft id is invalid");
  if (!NONCE_RE.test(payload.nonce)) throw new Error("chat draft nonce is invalid");
  if (!KINDS.has(payload.kind)) throw new Error("chat draft kind is invalid");
  if (
    !payload.title.trim() ||
    utf8Bytes(payload.title) > CHAT_DRAFT_LIMITS.maxTitle ||
    hasUnsafeControls(payload.title, false)
  ) {
    throw new Error("chat draft title is invalid");
  }
  if (
    utf8Bytes(payload.context) > CHAT_DRAFT_LIMITS.maxContext ||
    hasUnsafeControls(payload.context, true)
  ) {
    if (hasUnsafeControls(payload.context, true)) {
      throw new Error("chat draft context contains terminal control bytes");
    }
    throw new Error("chat draft context exceeds its bound");
  }
  if (
    typeof payload.sourceUrlRedacted !== "boolean" ||
    typeof payload.queryDataPresent !== "boolean"
  ) {
    throw new Error("chat draft URL privacy metadata is invalid");
  }
  if (!Number.isSafeInteger(payload.createdAt) || !Number.isSafeInteger(payload.expiresAt)) {
    throw new Error("chat draft timestamps are invalid");
  }
  if (payload.createdAt > now + MAX_FUTURE_SKEW_MS) {
    throw new Error("chat draft timestamp is too far in the future");
  }
  if (payload.expiresAt <= now) throw new Error("chat draft has expired");
  if (
    payload.expiresAt <= payload.createdAt ||
    payload.expiresAt - payload.createdAt > CHAT_DRAFT_LIMITS.maxLifetimeMs
  ) {
    throw new Error("chat draft lifetime is invalid");
  }
  let source: URL;
  try {
    source = new URL(payload.sourceUrl);
  } catch {
    throw new Error("chat draft source URL is invalid");
  }
  if (
    !["http:", "https:"].includes(source.protocol) ||
    !source.hostname ||
    source.username ||
    source.password ||
    source.hash ||
    source.origin === expectedHandoffOrigin
  ) {
    throw new Error("chat draft source URL is not allowed");
  }
}

export function createChatDraftRegistry(options: RegistryOptions): ChatDraftRegistry {
  const now = options.now ?? Date.now;
  const drafts = new Map<string, ChatDraft>();
  const usedNonces = new Map<string, number>();
  const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<(drafts: readonly ChatDraft[]) => void>();

  const pruneExpired = (at: number): boolean => {
    let changed = false;
    for (const [nonce, expiresAt] of usedNonces) {
      if (expiresAt <= at) usedNonces.delete(nonce);
    }
    for (const [id, draft] of drafts) {
      if (draft.expiresAt <= at) {
        drafts.delete(id);
        const timer = expiryTimers.get(id);
        if (timer) clearTimeout(timer);
        expiryTimers.delete(id);
        changed = true;
      }
    }
    return changed;
  };

  const snapshot = () => Array.from(drafts.values()).map((draft) => ({ ...draft }));
  const notify = () => {
    const current = snapshot();
    for (const listener of listeners) listener(current);
  };
  const syncExpiry = () => {
    if (pruneExpired(now())) notify();
  };
  const list = () => {
    syncExpiry();
    return snapshot();
  };

  return {
    openDraft(payload) {
      const openedAt = now();
      if (pruneExpired(openedAt)) notify();
      validatePayload(payload, options.expectedHandoffOrigin, openedAt);
      const existing = drafts.get(payload.id);
      if (existing && samePayload(existing, payload)) {
        return { ...existing };
      }
      if (usedNonces.has(payload.nonce)) {
        throw new Error("chat draft replay rejected");
      }
      if (existing) {
        throw new Error("chat draft id already exists");
      }
      if (drafts.size >= CHAT_DRAFT_LIMITS.maxDrafts) {
        throw new Error("chat draft capacity reached");
      }
      const draft: ChatDraft = { ...payload, acknowledged: false, state: "pending" };
      drafts.set(draft.id, draft);
      usedNonces.set(draft.nonce, draft.expiresAt);
      expiryTimers.set(
        draft.id,
        setTimeout(() => {
          if (pruneExpired(now())) notify();
        }, Math.max(0, draft.expiresAt - openedAt)),
      );
      notify();
      return { ...draft };
    },
    subscribe(listener) {
      syncExpiry();
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    get(id) {
      syncExpiry();
      const draft = drafts.get(id);
      return draft ? { ...draft } : null;
    },
    acknowledge(id) {
      syncExpiry();
      const draft = drafts.get(id);
      if (!draft) return false;
      draft.acknowledged = true;
      if (draft.state === "pending") draft.state = "acknowledged";
      notify();
      return true;
    },
    markInserted(id) {
      syncExpiry();
      const draft = drafts.get(id);
      if (!draft || !draft.acknowledged || draft.state !== "acknowledged") return false;
      draft.state = "inserted-unknown";
      notify();
      return true;
    },
    markInsertionFailed(id) {
      syncExpiry();
      const draft = drafts.get(id);
      if (!draft || draft.state !== "acknowledged") return false;
      draft.state = "failed";
      notify();
      return true;
    },
    markSubmissionUnknown(id) {
      syncExpiry();
      const draft = drafts.get(id);
      if (!draft || draft.state !== "inserted-unknown") return false;
      draft.state = "submitted-unknown";
      notify();
      return true;
    },
    markSubmissionFailed(id) {
      syncExpiry();
      const draft = drafts.get(id);
      if (!draft || draft.state !== "inserted-unknown") return false;
      draft.state = "failed";
      notify();
      return true;
    },
    clear(id) {
      syncExpiry();
      const removed = drafts.delete(id);
      const timer = expiryTimers.get(id);
      if (timer) clearTimeout(timer);
      expiryTimers.delete(id);
      if (removed) notify();
      return removed;
    },
    clearAll() {
      syncExpiry();
      const count = drafts.size;
      for (const timer of expiryTimers.values()) clearTimeout(timer);
      expiryTimers.clear();
      drafts.clear();
      if (count) notify();
      return count;
    },
    list,
  };
}

let currentOrigin = "";
let currentRegistry: ChatDraftRegistry | null = null;

/** Return the process-local draft registry for this exact Dashboard origin. */
export function getChatDraftRegistry(expectedHandoffOrigin: string): ChatDraftRegistry {
  if (!currentRegistry || currentOrigin !== expectedHandoffOrigin) {
    currentOrigin = expectedHandoffOrigin;
    currentRegistry = createChatDraftRegistry({ expectedHandoffOrigin });
  }
  return currentRegistry;
}
