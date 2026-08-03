import type { ChatDraftPayload, ChatDraftRegistry } from "./chat-drafts";

export const IMPERATOR_BROWSER_HELPER_ID = "ljcbkleholaaiefaichoinoknjdcpkjj";
export const IMPERATOR_HANDOFF_VERSION = 2;
const RESPONSE_TIMEOUT_MS = 2_500;
const ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const NONCE_RE = /^[A-Fa-f0-9]{32,128}$/;
const CHALLENGE_RE = /^[A-Fa-f0-9]{64,128}$/;

export type ChatDraftImportResult = {
  disposition: "imported" | "empty" | "unknown";
  draftId?: string;
  message: string;
};

type ExternalResponse = {
  ok?: boolean;
  version?: number;
  disposition?: string;
  id?: string;
  nonce?: string;
  challenge?: string;
  payload?: ChatDraftPayload | null;
  error?: string;
};

type ChromeRuntimeLike = {
  lastError?: { message?: string };
  sendMessage(
    extensionId: string,
    request: Record<string, unknown>,
    callback: (response: ExternalResponse | undefined) => void,
  ): void;
};

function runtimeFromGlobal(): ChromeRuntimeLike {
  const chromeValue = (globalThis as unknown as { chrome?: { runtime?: ChromeRuntimeLike } }).chrome;
  if (!chromeValue?.runtime || typeof chromeValue.runtime.sendMessage !== "function") {
    throw new Error("Imperator Browser Helper is unavailable to native Chat");
  }
  return chromeValue.runtime;
}

function requestExtension(request: Record<string, unknown>): Promise<ExternalResponse> {
  return new Promise((resolve, reject) => {
    let runtime: ChromeRuntimeLike;
    try {
      runtime = runtimeFromGlobal();
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Browser Helper response timed out; status is unknown and no retry occurred"));
    }, RESPONSE_TIMEOUT_MS);
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      action();
    };
    try {
      runtime.sendMessage(IMPERATOR_BROWSER_HELPER_ID, request, (response) => {
        if (runtime.lastError) {
          finish(() => reject(new Error("Browser Helper did not respond; status is unknown")));
          return;
        }
        if (!response || response.ok !== true || response.version !== IMPERATOR_HANDOFF_VERSION) {
          finish(() => reject(new Error(response?.error || "Browser Helper rejected the native request")));
          return;
        }
        finish(() => resolve(response));
      });
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error("Browser Helper request failed")));
    }
  });
}

function requireProbe(response: ExternalResponse) {
  if (
    !response.id || !ID_RE.test(response.id) ||
    !response.nonce || !NONCE_RE.test(response.nonce) ||
    !response.challenge || !CHALLENGE_RE.test(response.challenge) ||
    response.payload !== null
  ) {
    throw new Error("Browser Helper challenge response is invalid");
  }
  return { id: response.id, nonce: response.nonce, challenge: response.challenge };
}

const importerByRegistry = new WeakMap<ChatDraftRegistry, { importReviewedContext(): Promise<ChatDraftImportResult> }>();

export function createNativeChatDraftImporter(registry: ChatDraftRegistry): {
  importReviewedContext(): Promise<ChatDraftImportResult>;
} {
  const existing = importerByRegistry.get(registry);
  if (existing) return existing;
  let inFlight: Promise<ChatDraftImportResult> | null = null;

  async function runImport(): Promise<ChatDraftImportResult> {
    const probe = requireProbe(await requestExtension({
      type: "probe",
      version: IMPERATOR_HANDOFF_VERSION,
    }));
    const credentials = {
      version: IMPERATOR_HANDOFF_VERSION,
      id: probe.id,
      nonce: probe.nonce,
      challenge: probe.challenge,
    };
    const pulled = await requestExtension({ type: "pull", ...credentials });
    if (!pulled.payload) {
      return {
        disposition: pulled.disposition === "cleared" ? "empty" : "unknown",
        message: "No reviewed browser context was returned; no retry occurred.",
      };
    }

    const draft = registry.openDraft(pulled.payload);
    if (draft.id !== probe.id || draft.nonce !== probe.nonce) {
      registry.clear(draft.id);
      throw new Error("Browser Helper payload does not match the issued challenge");
    }
    await requestExtension({ type: "accepted", ...credentials });
    if (!registry.acknowledge(draft.id)) {
      throw new Error("Native volatile draft acknowledgement failed");
    }
    await requestExtension({ type: "ack", ...credentials });
    return {
      disposition: "imported",
      draftId: draft.id,
      message: "Reviewed context imported into native volatile memory. Nothing was sent.",
    };
  }

  const importer = {
    importReviewedContext() {
      if (inFlight) return inFlight;
      inFlight = runImport().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
  importerByRegistry.set(registry, importer);
  return importer;
}
