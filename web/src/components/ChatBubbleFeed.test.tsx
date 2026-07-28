import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ChatBubbleFeed } from "./ChatBubbleFeed";

const baseProps = {
  disabled: false,
  focusSignal: 0,
  isWorking: true,
  messages: [],
  onApproval: vi.fn(),
  onWriteApproval: vi.fn(),
  onClarify: vi.fn(),
  onComposerChange: vi.fn(),
  onImages: vi.fn(),
  onRetry: vi.fn(),
  onStop: vi.fn(),
  onSubmit: vi.fn(),
  onToggleRawConsole: vi.fn(),
  rawConsoleOpen: false,
};

describe("busy chat composer", () => {
  it("shows Stop when the agent is working and the composer is empty", () => {
    const html = renderToStaticMarkup(<ChatBubbleFeed {...baseProps} composer="" />);

    expect(html).toContain('aria-label="Stop agent"');
  });

  it("sends plain visible text for queue or steer without exposing slash commands", () => {
    const html = renderToStaticMarkup(
      <ChatBubbleFeed {...baseProps} composer="Please focus on the test failure" />,
    );

    expect(html).toContain(
      'aria-label="Queue message — sends when Imperator finishes"',
    );
    expect(html).toContain("messages will queue");
    expect(html).toContain("Please focus on the test failure");
    expect(html).not.toContain("/queue");
    expect(html).not.toContain("/steer");
  });
});

describe("chat feed refinements", () => {
  it("keeps composer controls accessible without keyboard helper copy", () => {
    const html = renderToStaticMarkup(<ChatBubbleFeed {...baseProps} composer="" />);

    expect(html).toContain('aria-label="Message Imperator"');
    expect(html).toContain('aria-label="Stop agent"');
    expect(html).not.toContain("Enter sends");
    expect(html).not.toContain("Shift+Enter");
  });

  it("uses an understated accessible chat icon for the empty state", () => {
    const html = renderToStaticMarkup(<ChatBubbleFeed {...baseProps} composer="" />);

    expect(html).toContain('aria-label="Start a new chat"');
    expect(html).toContain("lucide-messages-square");
    expect(html).not.toContain("lucide-sparkles");
  });

  it("keeps a waiting write approval actionable while the agent is working", () => {
    const html = renderToStaticMarkup(
      <ChatBubbleFeed
        {...baseProps}
        composer=""
        isWorking
        messages={[
          {
            id: "write-memory-1",
            role: "write_approval",
            text: "Memory change staged for review",
            status: "waiting",
            timestamp: 100,
            pendingId: "mem12345",
            subsystem: "memory",
          },
        ]}
      />,
    );

    expect(html).toContain("Approve change");
    expect(html).toContain("Reject change");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Approve change/);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Reject change/);
  });

  it("disables write approval only for that submitting card or unavailable transport", () => {
    const submitting = renderToStaticMarkup(
      <ChatBubbleFeed
        {...baseProps}
        composer=""
        messages={[
          {
            id: "write-memory-1",
            role: "write_approval",
            text: "Submitting",
            status: "running",
            timestamp: 100,
            pendingId: "mem12345",
            subsystem: "memory",
          },
        ]}
      />,
    );
    const unavailable = renderToStaticMarkup(
      <ChatBubbleFeed
        {...baseProps}
        composer=""
        writeApprovalDisabled
        messages={[
          {
            id: "write-memory-2",
            role: "write_approval",
            text: "Waiting",
            status: "waiting",
            timestamp: 101,
            pendingId: "mem67890",
            subsystem: "memory",
          },
        ]}
      />,
    );

    expect(submitting).toContain("Submitting decision");
    expect(submitting).toContain('disabled=""');
    expect(unavailable).toContain("Approve change");
    expect(unavailable).toContain('disabled=""');
  });

  it("keeps HTTP write approval available while the PTY composer reconnects", () => {
    const html = renderToStaticMarkup(
      <ChatBubbleFeed
        {...baseProps}
        composer=""
        disabled
        writeApprovalDisabled={false}
        messages={[
          {
            id: "write-memory-reconnect",
            role: "write_approval",
            text: "Waiting",
            status: "waiting",
            timestamp: 102,
            pendingId: "mem-reconnect",
            subsystem: "memory",
          },
        ]}
      />,
    );

    expect(html).toContain("Approve change");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Approve change/);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Reject change/);
  });
});
