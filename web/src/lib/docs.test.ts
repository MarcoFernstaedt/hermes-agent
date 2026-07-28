import { describe, expect, it } from "vitest";

import {
  flattenDocs,
  hasDocPage,
  imperatorDocText,
  preprocessDoc,
} from "./docs";

describe("docs manifest", () => {
  it("indexes the bundled manual", () => {
    const flat = flattenDocs();
    expect(flat.length).toBeGreaterThan(300);
    expect(hasDocPage("getting-started/quickstart")).toBe(true);
    expect(hasDocPage("user-guide/messaging/telegram")).toBe(true);
  });
});

describe("imperatorDocText", () => {
  it("rebrands prose but keeps the Nous Portal product name", () => {
    expect(imperatorDocText("Hermes Agent is built by Nous Research")).toBe(
      "Imperator is built by Imperator Systems",
    );
    expect(imperatorDocText("Log in with Nous Portal")).toBe(
      "Log in with Nous Portal",
    );
  });
});

describe("preprocessDoc", () => {
  it("strips frontmatter and converts admonitions to blockquotes", () => {
    const raw = [
      "---",
      "title: Test",
      "---",
      ":::tip Fast path",
      "Run the setup.",
      ":::",
    ].join("\n");
    const output = preprocessDoc(raw, "guides/test");
    expect(output).not.toContain("title: Test");
    expect(output).toContain("> **Tip: Fast path**");
    expect(output).toContain("> Run the setup.");
  });

  it("drops multi-line raw HTML embeds but keeps code fences", () => {
    const raw = [
      "<div style={{position: 'relative'}}>",
      "<iframe",
      'src="https://example.com/embed"',
      "></iframe>",
      "</div>",
      "",
      "```bash",
      "<div> stays literal in code",
      "```",
    ].join("\n");
    const output = preprocessDoc(raw, "guides/test");
    expect(output).not.toContain("iframe");
    expect(output).toContain("<div> stays literal in code");
  });

  it("rewrites internal doc links onto the in-app route", () => {
    const raw = "See [quickstart](/docs/getting-started/quickstart) first.";
    const output = preprocessDoc(raw, "guides/test");
    expect(output).toContain(
      "](/docs?page=getting-started%2Fquickstart)",
    );
  });

  it("resolves relative links against the current page", () => {
    const raw = "See [installation](../getting-started/installation.md).";
    const output = preprocessDoc(raw, "guides/tips");
    expect(output).toContain(
      "](/docs?page=getting-started%2Finstallation)",
    );
  });

  it("leaves external links untouched", () => {
    const raw = "Get a key at [xAI](https://console.x.ai/).";
    expect(preprocessDoc(raw, "guides/test")).toContain(
      "(https://console.x.ai/)",
    );
  });
});
