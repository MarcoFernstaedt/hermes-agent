import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ChatBubbleFeed } from "./ChatBubbleFeed";

const baseProps = {
  disabled: false,
  focusSignal: 0,
  isWorking: true,
  messages: [],
  onApproval: vi.fn(),
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

    expect(html).toContain('aria-label="Send while agent is working"');
    expect(html).toContain("Please focus on the test failure");
    expect(html).not.toContain("/queue");
    expect(html).not.toContain("/steer");
  });
});
