import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { PageHeaderProvider } from "./PageHeaderProvider";

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && /\.tsx$/u.test(entry.name) ? [full] : [];
  });
}

describe("Dashboard main landmark ownership", () => {
  it("gives the host exactly one composed main and leaves route/plugin content main-free", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const occurrences = sourceFiles(root).flatMap((file) => {
      const source = fs.readFileSync(file, "utf8");
      return Array.from(source.matchAll(/<main\b/gu), () => file);
    });

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatch(/PageHeaderProvider\.tsx$/u);
    const owner = fs.readFileSync(occurrences[0], "utf8");
    expect(owner).toContain('id="hermes-main-content"');
    expect(owner).toContain('tabIndex={-1}');
  });

  it("renders one composed host main around route and plugin content", () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/imperator"] },
        createElement(
          PageHeaderProvider,
          {
            pluginTabs: [{ path: "/imperator", label: "Imperator" }],
            children: createElement("section", { "aria-label": "Plugin projection" }, "Plugin route content"),
          },
        ),
      ),
    );
    expect(html.match(/<main\b/gu)).toHaveLength(1);
    expect(html).toContain('id="hermes-main-content"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-label="Plugin projection"');
    expect(html.indexOf("<main")).toBeLessThan(html.indexOf("Plugin route content"));
  });

  it("enables xterm screen reader output and uses the conservative production enqueue seam", () => {
    const chatPage = fs.readFileSync(path.resolve(import.meta.dirname, "../pages/ChatPage.tsx"), "utf8");
    expect(chatPage).toContain("screenReaderMode: true");
    expect(chatPage).toContain("term.onData");
    expect(chatPage).toContain("enqueuePtyOnData");
    expect(chatPage).toContain("send: (nextData) => ws.send(nextData)");
    expect(chatPage).not.toContain('return wsRef.current?.readyState === WebSocket.OPEN ? "confirmed"');
  });
});
