import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ChatDraftComposer } from "./ChatDraftComposer";
import type { ChatDraft } from "@/plugins/chat-drafts";

const draft: ChatDraft = {
  id: "draft-1",
  nonce: "0123456789abcdef0123456789abcdef",
  kind: "selection",
  title: "Reviewed page",
  sourceUrl: "https://example.com/article?view=wide",
  sourceUrlRedacted: true,
  queryDataPresent: true,
  context: "Bounded context",
  handoffOrigin: "https://dashboard.example.test",
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  acknowledged: true,
  state: "acknowledged",
};

function render(overrides: Partial<Parameters<typeof ChatDraftComposer>[0]> = {}) {
  return renderToStaticMarkup(
    <ChatDraftComposer
      draft={draft}
      connected
      busy={false}
      nativeInputState="empty"
      onInsert={vi.fn()}
      onDismiss={vi.fn()}
      {...overrides}
    />,
  );
}

describe("ChatDraftComposer", () => {
  it("renders editable review fields URL privacy disclosure and a zero-send insertion action", () => {
    const html = render();

    expect(html).toContain("Review browser context");
    expect(html).toContain("Reviewed title");
    expect(html).toContain("Reviewed website material");
    expect(html).toContain("What should Hermes do with this context?");
    expect(html).toContain("Sensitive query fields or the private fragment were removed");
    expect(html).toContain("non-credential query data remains");
    expect(html).toContain("Insert into native Chat input");
    expect(html).not.toContain("Send reviewed context");
  });

  it("discloses volatile retention and push-to-talk privacy and fallback semantics", () => {
    const html = render();

    expect(html).toContain("process-local memory");
    expect(html).toContain("expires automatically");
    expect(html).toContain("not stored by Hermes");
    expect(html).toContain("browser speech service");
    expect(html).toContain("After you use native Send, Hermes and the configured model provider process the message");
    expect(html).toContain("normal conversation retention settings");
    expect(html).toContain("Push to talk");
    expect(html).toContain("Speech recognition unavailable");
    expect(html).toContain("You can still type the request");
  });

  it.each([
    ["disconnected", { connected: false }, "Reconnect Chat before inserting"],
    ["busy", { busy: true }, "Wait for the current turn to finish"],
    ["existing input", { nativeInputState: "non-empty" as const }, "Native Chat input already contains text"],
    ["unknown input", { nativeInputState: "unknown" as const }, "Native Chat input state is unknown"],
  ])("disables insertion when Chat is %s", (_label, props, message) => {
    const html = render(props);
    expect(html).toContain(message);
    expect(html).toContain('disabled="" class="min-h-11 border border-current bg-current');
  });

  it("retains an insertion with unknown PTY acceptance for manual confirmation", () => {
    const html = render({ draft: { ...draft, state: "inserted-unknown" } });

    expect(html).toContain("PTY acceptance is unknown");
    expect(html).toContain("Do not retry automatically");
    expect(html).toContain("remains visible until you inspect Chat and dismiss it");
    expect(html).toContain("Insertion status unknown");
    expect(html).toContain('disabled="" class="min-h-11 border border-current bg-current');
  });

  it("discloses submission ambiguity and failed enqueue without asserting provider acceptance", () => {
    expect(render({ draft: { ...draft, state: "submitted-unknown" } })).toContain("Submission acceptance is unknown");
    expect(render({ draft: { ...draft, state: "failed" } })).toContain("Enqueue failed");
  });
});
