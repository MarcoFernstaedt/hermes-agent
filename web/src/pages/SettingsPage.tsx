import { useState } from "react";
import { Link } from "react-router-dom";
import {
  BarChart3,
  BellRing,
  ChevronRight,
  KeyRound,
  MessagesSquare,
  Settings,
  Wrench,
} from "lucide-react";

import { Card } from "@nous-research/ui/ui/components/card";
import { Switch } from "@nous-research/ui/ui/components/switch";
import { setAppSetting, useAppSettings } from "@/lib/app-settings";
import { requestNotificationPermission } from "@/lib/notify";
import { cn } from "@/lib/utils";

/**
 * Settings — app-level preferences plus one-tap paths into the deeper
 * configuration areas. Controls live here exactly once; settings owned by
 * a specific surface (e.g. "Show tool activity" in the chat panel) are
 * pointed to, never duplicated.
 */

const AREA_LINKS = [
  {
    to: "/env",
    icon: KeyRound,
    label: "Providers & API keys",
    description: "Add model providers, manage credentials and tokens",
  },
  {
    to: "/config",
    icon: Settings,
    label: "Configuration",
    description: "Every agent setting — model, terminal, approvals, memory",
  },
  {
    to: "/analytics",
    icon: BarChart3,
    label: "Usage & analytics",
    description: "Token usage, cost, and session activity over time",
  },
  {
    to: "/system",
    icon: Wrench,
    label: "System",
    description: "Gateway, updates, backups, diagnostics, credential pool",
  },
] as const;

export default function SettingsPage() {
  const settings = useAppSettings();
  const [permissionHint, setPermissionHint] = useState<string | null>(null);

  const handleNotificationsToggle = async (checked: boolean) => {
    setPermissionHint(null);
    if (!checked) {
      setAppSetting("notificationsEnabled", false);
      return;
    }
    const granted = await requestNotificationPermission();
    if (granted) {
      setAppSetting("notificationsEnabled", true);
    } else {
      setAppSetting("notificationsEnabled", false);
      setPermissionHint(
        "Notifications are blocked for this site. Allow them in your browser or system settings, then try again.",
      );
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <BellRing className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <div className="text-sm font-medium">Reply notifications</div>
              <p className="mt-0.5 text-xs text-text-secondary">
                Notifies you when Imperator finishes a reply while you're
                away, and badges the app icon with unread replies. Tool
                calls never notify.
              </p>
            </div>
          </div>
          <Switch
            checked={settings.notificationsEnabled}
            onCheckedChange={(checked) =>
              void handleNotificationsToggle(checked === true)
            }
            aria-label="Enable reply notifications"
          />
        </div>
        {permissionHint && (
          <p className="text-xs text-warning">{permissionHint}</p>
        )}
      </Card>

      <Card className="p-0">
        <ul className="flex flex-col divide-y divide-current/10">
          {AREA_LINKS.map(({ to, icon: Icon, label, description }) => (
            <li key={to}>
              <Link
                to={to}
                className={cn(
                  "flex min-h-[44px] items-center gap-3 px-4 py-3",
                  "transition-colors hover:bg-midground/5 active:opacity-70",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground",
                )}
              >
                <Icon className="size-4 shrink-0 text-text-secondary" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{label}</span>
                  <span className="block truncate text-xs text-text-secondary">
                    {description}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-text-tertiary" />
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      <p className="flex items-center gap-2 px-1 text-xs text-text-tertiary">
        <MessagesSquare className="size-3.5 shrink-0" />
        Chat-specific settings (like showing tool activity) live in the
        chat's Model &amp; tools panel.
      </p>
    </div>
  );
}
