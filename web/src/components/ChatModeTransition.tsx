import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type ChatMode = "feed" | "console";

interface ChatModeTransitionProps {
  activeMode: ChatMode;
  feed: ReactNode;
  console: ReactNode;
  className?: string;
}

const MODE_LABEL: Record<ChatMode, string> = {
  feed: "Chat Feed",
  console: "Raw Console",
};

const MODE_MOTION: Record<ChatMode, { active: string; inactive: string }> = {
  feed: {
    active: "opacity-100 translate-x-0 scale-100 blur-0",
    inactive:
      "pointer-events-none opacity-0 -translate-x-2 sm:-translate-x-3 scale-[0.985] blur-[2px]",
  },
  console: {
    active: "opacity-100 translate-x-0 scale-100 blur-0",
    inactive:
      "pointer-events-none opacity-0 translate-x-2 sm:translate-x-3 scale-[0.985] blur-[2px]",
  },
};

export function ChatModeTransition({
  activeMode,
  feed,
  console,
  className,
}: ChatModeTransitionProps) {
  const panels: Record<ChatMode, ReactNode> = { feed, console };

  return (
    <div className={cn("relative flex min-h-0 min-w-0 flex-1", className)}>
      {(["feed", "console"] as const).map((mode) => {
        const active = mode === activeMode;

        return (
          <section
            key={mode}
            data-chat-mode={mode}
            data-state={active ? "active" : "inactive"}
            aria-label={MODE_LABEL[mode]}
            aria-hidden={!active}
            inert={active ? undefined : true}
            className={cn(
              "absolute inset-0 flex min-h-0 min-w-0 flex-col",
              "motion-safe:transition-[opacity,transform,filter] motion-safe:duration-300 motion-safe:ease-out",
              "motion-reduce:transition-none motion-reduce:transform-none motion-reduce:blur-none",
              active ? MODE_MOTION[mode].active : MODE_MOTION[mode].inactive,
            )}
          >
            {panels[mode]}
          </section>
        );
      })}
    </div>
  );
}
