import { afterEach, describe, expect, it } from "vitest";

import { getChatDraftRegistry } from "./chat-drafts";
import { exposePluginSDK } from "./registry";

const originalWindow = globalThis.window;
const chromeGlobal = globalThis as unknown as { chrome?: unknown };
const originalChrome = chromeGlobal.chrome;

describe("Dashboard plugin SDK chatDrafts contract", () => {
  afterEach(() => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      globalThis.window = originalWindow;
    }
    if (originalChrome === undefined) {
      Reflect.deleteProperty(chromeGlobal, "chrome");
    } else {
      chromeGlobal.chrome = originalChrome;
    }
  });

  it("exposes only a no-payload native import trigger", () => {
    const fakeWindow = {
      location: { origin: "https://dashboard.example.test" },
    } as unknown as Window & typeof globalThis;
    globalThis.window = fakeWindow;

    exposePluginSDK();

    const drafts = fakeWindow.__HERMES_PLUGIN_SDK__?.chatDrafts;
    expect(drafts).toBeDefined();
    expect(Object.keys(drafts ?? {})).toEqual(["importReviewedContext"]);
    expect(drafts?.importReviewedContext.length).toBe(0);
    expect("openDraft" in (drafts ?? {})).toBe(false);
    expect("send" in (drafts ?? {})).toBe(false);
    expect("persist" in (drafts ?? {})).toBe(false);
  });

  it("has native code obtain and validate payload through probe and credentialed pull", async () => {
    const origin = "https://dashboard.example.test";
    const now = Date.now();
    const requests: Record<string, unknown>[] = [];
    const payload = {
      id: "native-import",
      nonce: "a".repeat(32),
      kind: "selection" as const,
      title: "Reviewed source",
      sourceUrl: "https://example.com/article",
      sourceUrlRedacted: false,
      queryDataPresent: false,
      context: "Bounded context",
      handoffOrigin: origin,
      createdAt: now,
      expiresAt: now + 60_000,
    };
    const challenge = "b".repeat(64);
    const fakeWindow = { location: { origin } } as unknown as Window & typeof globalThis;
    globalThis.window = fakeWindow;
    chromeGlobal.chrome = {
      runtime: {
        lastError: undefined,
        sendMessage(_extensionId: string, request: Record<string, unknown>, callback: (response: unknown) => void) {
          requests.push(request);
          if (request.type === "probe") callback({ ok: true, version: 2, id: payload.id, nonce: payload.nonce, challenge, payload: null });
          else if (request.type === "pull") callback({ ok: true, version: 2, disposition: "pulled", payload });
          else callback({ ok: true, version: 2, disposition: request.type === "accepted" ? "native-accepted" : "acknowledged", payload: null });
        },
      },
    };

    exposePluginSDK();
    const result = await fakeWindow.__HERMES_PLUGIN_SDK__?.chatDrafts.importReviewedContext();

    expect(result).toMatchObject({ disposition: "imported", draftId: payload.id });
    expect(requests.map((request) => request.type)).toEqual(["probe", "pull", "accepted", "ack"]);
    expect(requests[1]).toMatchObject({ id: payload.id, nonce: payload.nonce, challenge });
    expect(requests[2]).toMatchObject({ id: payload.id, nonce: payload.nonce, challenge });
    expect(requests[3]).toMatchObject({ id: payload.id, nonce: payload.nonce, challenge });
    expect(getChatDraftRegistry(origin).get(payload.id)?.state).toBe("acknowledged");
  });
});
