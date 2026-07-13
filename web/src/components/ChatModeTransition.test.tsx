import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatModeTransition } from "./ChatModeTransition";

describe("ChatModeTransition", () => {
  it("keeps both chat surfaces mounted while exposing only the active mode", () => {
    const html = renderToStaticMarkup(
      <ChatModeTransition
        activeMode="feed"
        feed={<div>semantic feed</div>}
        console={<div>lossless terminal</div>}
      />,
    );

    expect(html).toContain("semantic feed");
    expect(html).toContain("lossless terminal");
    expect(html).toContain('data-chat-mode="feed"');
    expect(html).toContain('data-state="active"');
    expect(html).toContain('data-chat-mode="console"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("provides responsive motion with an explicit reduced-motion fallback", () => {
    const html = renderToStaticMarkup(
      <ChatModeTransition
        activeMode="console"
        feed={<div>semantic feed</div>}
        console={<div>lossless terminal</div>}
      />,
    );

    expect(html).toContain("motion-safe:duration-300");
    expect(html).toContain("motion-reduce:transition-none");
    expect(html).toContain("motion-reduce:transform-none");
  });
});
