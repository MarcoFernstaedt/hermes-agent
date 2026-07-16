import type { GatewayClient } from "@/lib/gatewayClient";
import { nextSlashSelection } from "@/lib/slash-selection";
import { shouldShowSlashCommands } from "@/lib/chat-feed-model";
import { ListItem } from "@nous-research/ui/ui/components/list-item";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

/**
 * Slash-command autocomplete popover, rendered above the composer in ChatPage.
 * Mirrors the completion UX of the Ink TUI — type `/`, see matching commands,
 * arrow keys or click to select, Tab to apply, Enter to submit.
 *
 * The parent owns all keyboard handling via `ref.handleKey`, which returns
 * true when the popover consumed the event, so the composer's Enter/arrow
 * logic stays in one place.
 */

export interface CompletionItem {
  display: string;
  text: string;
  meta?: string;
}

export interface SlashPopoverHandle {
  /** Returns true if the key was consumed by the popover. */
  handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean;
}

interface Props {
  input: string;
  gw: GatewayClient | null;
  onApply(nextInput: string): void;
}

interface CompletionResponse {
  items?: CompletionItem[];
  replace_from?: number;
}

const DEBOUNCE_MS = 60;

export const SlashPopover = forwardRef<SlashPopoverHandle, Props>(
  function SlashPopover({ input, gw, onApply }, ref) {
    const [items, setItems] = useState<CompletionItem[]>([]);
    const [selected, setSelected] = useState(0);
    const [replaceFrom, setReplaceFrom] = useState(1);
    const lastInputRef = useRef<string>("");
    const listRef = useRef<HTMLDivElement | null>(null);

    // Debounced completion fetch. We never clear `items` in the effect body
    // (doing so would flag react-hooks/set-state-in-effect); instead the
    // render guard below hides stale items once the input stops matching.
    useEffect(() => {
      const trimmed = input ?? "";

      if (!gw || !trimmed.startsWith("/") || trimmed === lastInputRef.current) {
        if (!trimmed.startsWith("/")) lastInputRef.current = "";
        return;
      }
      lastInputRef.current = trimmed;

      const timer = window.setTimeout(async () => {
        if (lastInputRef.current !== trimmed) return;
        try {
          const r = await gw.request<CompletionResponse>("complete.slash", {
            text: trimmed,
          });
          if (lastInputRef.current !== trimmed) return;
          setItems(r?.items ?? []);
          setReplaceFrom(r?.replace_from ?? 1);
          setSelected(0);
        } catch {
          if (lastInputRef.current === trimmed) setItems([]);
        }
      }, DEBOUNCE_MS);

      return () => window.clearTimeout(timer);
    }, [input, gw]);

    const apply = useCallback(
      (item: CompletionItem) => {
        onApply(input.slice(0, replaceFrom) + item.text);
      },
      [input, replaceFrom, onApply],
    );

    // Only consume keys when the popover is actually visible. Stale items from
    // a previous slash prefix are ignored once the user deletes the "/".
    const visible = items.length > 0 && shouldShowSlashCommands(input);

    useEffect(() => {
      if (!visible) return;
      const selectedOption = listRef.current?.querySelector<HTMLElement>(
        `[data-slash-index="${selected}"]`,
      );
      selectedOption?.scrollIntoView({ block: "nearest" });
    }, [selected, visible]);

    useImperativeHandle(
      ref,
      () => ({
        handleKey: (e) => {
          if (!visible) return false;

          switch (e.key) {
            case "ArrowDown":
              e.preventDefault();
              setSelected((s) => nextSlashSelection(s, 1, items.length));
              return true;

            case "ArrowUp":
              e.preventDefault();
              setSelected((s) => nextSlashSelection(s, -1, items.length));
              return true;

            case "Tab": {
              e.preventDefault();
              const item = items[selected];
              if (item) apply(item);
              return true;
            }

            case "Escape":
              e.preventDefault();
              setItems([]);
              return true;

            default:
              return false;
          }
        },
      }),
      [visible, items, selected, apply],
    );

    if (!visible) return null;

    return (
      <div
        ref={listRef}
        // Phone-first sizing (Telegram-style command sheet): tall panel,
        // comfortable tap rows, readable text. Tightens back to the compact
        // desktop popover at ≥sm.
        className="absolute bottom-full left-0 right-0 mb-2 max-h-[45vh] overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover/95 shadow-xl backdrop-blur-md sm:max-h-64 sm:rounded-md"
        role="listbox"
      >
        {items.map((it, i) => {
          const active = i === selected;

          return (
            <ListItem
              key={`${it.text}-${i}`}
              active={active}
              role="option"
              aria-selected={active}
              data-slash-index={i}
              onMouseEnter={() => setSelected(i)}
              onClick={() => apply(it)}
              className={
                active
                  ? "min-h-[44px] px-4 py-2.5 sm:min-h-0 sm:px-3 sm:py-1.5 bg-primary/15 text-primary ring-1 ring-inset ring-primary/35"
                  : "min-h-[44px] px-4 py-2.5 sm:min-h-0 sm:px-3 sm:py-1.5"
              }
            >
              <span className="font-mono text-sm sm:text-xs shrink-0 truncate">
                {it.display}
              </span>

              {it.meta && (
                <span className="text-xs text-text-tertiary truncate ml-auto pl-3">
                  {it.meta}
                </span>
              )}
            </ListItem>
          );
        })}
      </div>
    );
  },
);
