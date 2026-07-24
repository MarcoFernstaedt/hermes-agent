import { describe, expect, it } from "vitest";

import {
  decodeBody,
  defaultExpanded,
  extractBodies,
  isUnread,
  parseSender,
  toRenderable,
} from "./email-model";
import type { GmailMessage } from "@/lib/api";

function b64url(s: string): string {
  // Encode UTF-8 bytes first, like Gmail does, so multi-byte chars round-trip.
  const bytes = new TextEncoder().encode(s);
  const bin = String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("email-model", () => {
  it("decodes base64url bodies", () => {
    expect(decodeBody(b64url("héllo world"))).toBe("héllo world");
    expect(decodeBody(undefined)).toBe("");
  });

  it("extracts plain and html alternatives from a multipart tree", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("plain body") } },
        { mimeType: "text/html", body: { data: b64url("<p>html body</p>") } },
        { mimeType: "application/pdf", filename: "a.pdf", body: { data: b64url("x") } },
      ],
    };
    const { text, html } = extractBodies(payload);
    expect(text).toBe("plain body");
    expect(html).toBe("<p>html body</p>");
  });

  it("parses sender name and address", () => {
    expect(parseSender("Alice Smith <alice@example.com>")).toEqual({
      name: "Alice Smith",
      email: "alice@example.com",
    });
    expect(parseSender("bob@example.com")).toEqual({
      name: "bob@example.com",
      email: "bob@example.com",
    });
  });

  it("flags remote content in html", () => {
    const msg: GmailMessage = {
      id: "1",
      threadId: "t1",
      payload: {
        mimeType: "text/html",
        headers: [
          { name: "Subject", value: "Hi" },
          { name: "From", value: "A <a@x.com>" },
        ],
        body: { data: b64url('<img src="https://tracker.example/pixel.gif">') },
      },
    };
    const r = toRenderable(msg);
    expect(r.subject).toBe("Hi");
    expect(r.from.email).toBe("a@x.com");
    expect(r.hasRemoteContent).toBe(true);
  });

  it("does not flag inline-only html as remote", () => {
    const msg: GmailMessage = {
      id: "1",
      threadId: "t1",
      payload: {
        mimeType: "text/html",
        body: { data: b64url('<p style="color:red">hi</p>') },
      },
    };
    expect(toRenderable(msg).hasRemoteContent).toBe(false);
  });

  it("detects unread by the UNREAD label", () => {
    expect(isUnread({ id: "1", threadId: "t", labelIds: ["INBOX", "UNREAD"] })).toBe(true);
    expect(isUnread({ id: "2", threadId: "t", labelIds: ["INBOX"] })).toBe(false);
    expect(isUnread({ id: "3", threadId: "t" })).toBe(false);
  });

  it("opens the last message and any unread ones by default", () => {
    const msgs: GmailMessage[] = [
      { id: "a", threadId: "t", labelIds: ["INBOX"] },
      { id: "b", threadId: "t", labelIds: ["INBOX", "UNREAD"] },
      { id: "c", threadId: "t", labelIds: ["INBOX"] },
    ];
    const open = defaultExpanded(msgs);
    expect(open.has("a")).toBe(false); // older, read
    expect(open.has("b")).toBe(true); // unread
    expect(open.has("c")).toBe(true); // last
  });

  it("opens the single message in a one-message thread", () => {
    const open = defaultExpanded([{ id: "only", threadId: "t", labelIds: ["INBOX"] }]);
    expect(open.has("only")).toBe(true);
  });
});
