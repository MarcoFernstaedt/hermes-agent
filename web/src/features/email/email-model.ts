/**
 * Pure helpers for turning a raw Gmail message into something renderable.
 * No React, so these are unit-tested directly.
 */
import type { GmailMessage, GmailPayload } from "@/lib/api";

/** Decode Gmail's base64url body data to a UTF-8 string. */
export function decodeBody(data: string | undefined): string {
  if (!data) return "";
  try {
    const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

export function getHeader(payload: GmailPayload | undefined, name: string): string {
  const lname = name.toLowerCase();
  for (const h of payload?.headers ?? []) {
    if (h.name.toLowerCase() === lname) return h.value;
  }
  return "";
}

/** Walk the MIME tree collecting the plain-text and HTML alternatives. */
export function extractBodies(payload: GmailPayload | undefined): {
  text: string;
  html: string;
} {
  let text = "";
  let html = "";
  const walk = (part: GmailPayload | undefined) => {
    if (!part) return;
    const mime = part.mimeType ?? "";
    if (mime === "text/plain" && !part.filename && part.body?.data) {
      text += decodeBody(part.body.data);
    } else if (mime === "text/html" && !part.filename && part.body?.data) {
      html += decodeBody(part.body.data);
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return { text, html };
}

export interface ParsedSender {
  name: string;
  email: string;
}

/** Split a `Name <addr@host>` header into display name + address. */
export function parseSender(from: string): ParsedSender {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim() };
  return { name: from.trim(), email: from.trim() };
}

export interface RenderableMessage {
  subject: string;
  from: ParsedSender;
  to: string;
  date: string;
  text: string;
  html: string;
  /** True when the HTML references remote (http/https) resources. */
  hasRemoteContent: boolean;
}

/** A Gmail message is unread while it still carries the UNREAD label. */
export function isUnread(message: GmailMessage): boolean {
  return (message.labelIds ?? []).includes("UNREAD");
}

/** Which messages in a thread should open by default: the last one, plus any
 *  still unread. Returns the set of their ids. Older, already-read messages
 *  stay collapsed so a long conversation reads as a tidy stack. */
export function defaultExpanded(messages: GmailMessage[]): Set<string> {
  const open = new Set<string>();
  for (const m of messages) if (isUnread(m)) open.add(m.id);
  const last = messages[messages.length - 1];
  if (last) open.add(last.id);
  return open;
}

export function toRenderable(message: GmailMessage): RenderableMessage {
  const { text, html } = extractBodies(message.payload);
  return {
    subject: getHeader(message.payload, "Subject"),
    from: parseSender(getHeader(message.payload, "From")),
    to: getHeader(message.payload, "To"),
    date: getHeader(message.payload, "Date"),
    text,
    html,
    hasRemoteContent: /(?:src|href|url\()\s*=?\s*["'(]?https?:\/\//i.test(html),
  };
}
