import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ChatDraft } from "@/plugins/chat-drafts";
import { ChatDraftInbox } from "./ChatDraftInbox";

function draft(id: string, createdAt: number): ChatDraft {
  return {
    id,
    nonce: id.padEnd(32, "a"),
    kind: "selection",
    title: id === "older" ? "Older reviewed context" : "Newer reviewed context",
    sourceUrl: "https://example.com/source",
    sourceUrlRedacted: false,
    queryDataPresent: false,
    context: "Bounded context",
    handoffOrigin: "https://dashboard.example.test",
    createdAt,
    expiresAt: createdAt + 600_000,
    acknowledged: true,
    state: "acknowledged",
  };
}

describe("ChatDraftInbox", () => {
  it("renders a volatile ordered inbox with inspect clear-one and clear-all controls", () => {
    const html = renderToStaticMarkup(
      <ChatDraftInbox
        drafts={[draft("newer", 2_000), draft("older", 1_000)]}
        connected
        busy={false}
        nativeInputState="empty"
        onInsert={vi.fn()}
        onDismiss={vi.fn()}
        onClearAll={vi.fn()}
      />,
    );

    expect(html).toContain("Browser context inbox");
    expect(html).toContain("2 volatile drafts · oldest first");
    expect(html).toContain("process-local memory only");
    expect(html).toContain("Clear all browser context");
    expect(html).toContain("Inspect Older reviewed context");
    expect(html).toContain("Inspect Newer reviewed context");
    expect(html.indexOf("Older reviewed context")).toBeLessThan(html.indexOf("Newer reviewed context"));
    expect(html.match(/Discard browser context/g)?.length).toBe(2);
  });

  it("shows an explicit locked empty posture", () => {
    const html = renderToStaticMarkup(
      <ChatDraftInbox
        drafts={[]}
        connected={false}
        busy={false}
        nativeInputState="unknown"
        onInsert={vi.fn()}
        onDismiss={vi.fn()}
        onClearAll={vi.fn()}
      />,
    );
    expect(html).toContain("No reviewed browser context is available");
    expect(html).toContain("Import and insertion are locked");
  });
});
