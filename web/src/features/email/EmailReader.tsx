import { useMemo, useState } from "react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Segmented } from "@nous-research/ui/ui/components/segmented";
import { ImageOff, Image as ImageIcon } from "lucide-react";

import type { RenderableMessage } from "./email-model";

/**
 * Renders a message body. Email HTML is hostile input, so it is shown inside a
 * sandboxed iframe (`sandbox=""` — no scripts, no same-origin) whose srcdoc
 * carries a strict CSP: `default-src 'none'` kills scripts and objects, and
 * `img-src` starts at `data:` only so remote images (tracking pixels) do not
 * load until I explicitly allow them per view. A plain-text alternative, when
 * present, is the default view — far safer and much better by screen reader.
 */
export function EmailReader({ message }: { message: RenderableMessage }) {
  const hasText = message.text.trim().length > 0;
  const hasHtml = message.html.trim().length > 0;
  const [mode, setMode] = useState<"text" | "html">(hasText || !hasHtml ? "text" : "html");
  const [allowImages, setAllowImages] = useState(false);

  const srcDoc = useMemo(() => {
    const imgSrc = allowImages ? "https: data:" : "data:";
    const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${imgSrc}`;
    const body =
      mode === "text"
        ? `<pre class="txt">${escapeHtml(message.text || message.html)}</pre>`
        : message.html;
    return [
      "<!doctype html><html><head><meta charset='utf-8'>",
      `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
      "<style>",
      "html,body{margin:0}",
      "body{background:#fff;color:#111;font:14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;padding:12px;word-break:break-word}",
      "img{max-width:100%;height:auto}",
      ".txt{white-space:pre-wrap;font:14px/1.55 system-ui,sans-serif;margin:0}",
      "a{color:#0b57d0}",
      "</style></head><body>",
      body,
      "</body></html>",
    ].join("");
  }, [mode, allowImages, message.text, message.html]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-1 pb-2">
        {hasText && hasHtml ? (
          <Segmented
            value={mode}
            onChange={(v) => setMode(v)}
            options={[
              { value: "text", label: "Text" },
              { value: "html", label: "HTML" },
            ]}
          />
        ) : (
          <span className="text-xs text-text-tertiary">
            {hasHtml ? "HTML message" : "Plain text"}
          </span>
        )}
        {mode === "html" && message.hasRemoteContent && (
          <Button
            size="sm"
            outlined
            prefix={allowImages ? <ImageOff /> : <ImageIcon />}
            onClick={() => setAllowImages((v) => !v)}
            aria-pressed={allowImages}
          >
            {allowImages ? "Block images" : "Show images"}
          </Button>
        )}
      </div>
      <iframe
        // sandbox="" is intentional: no allow-scripts, no allow-same-origin.
        sandbox=""
        srcDoc={srcDoc}
        title={`Message body: ${message.subject || "(no subject)"}`}
        className="min-h-0 flex-1 rounded-b bg-white"
      />
    </div>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
