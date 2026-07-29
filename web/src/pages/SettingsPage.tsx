import { useState } from "react";
import { Link } from "react-router-dom";
import {
  BarChart3,
  BellRing,
  ChevronRight,
  BookOpen,
  Cpu,
  KeyRound,
  MessagesSquare,
  Settings,
  Trophy,
  Wrench,
} from "lucide-react";

import { Card } from "@nous-research/ui/ui/components/card";
import { Switch } from "@nous-research/ui/ui/components/switch";
import { Segmented } from "@nous-research/ui/ui/components/segmented";
import { Check } from "lucide-react";
import {
  setAppSetting,
  useAppSettings,
  useSaveStatus,
  type AppSettings,
} from "@/lib/app-settings";
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
    to: "/models",
    icon: Cpu,
    label: "Models",
    description: "Main model, auxiliary tasks, mixture of agents",
  },
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
  {
    to: "/docs",
    icon: BookOpen,
    label: "Documentation",
    description: "The full Imperator manual, searchable in-app",
  },
  {
    to: "/achievements",
    icon: Trophy,
    label: "Achievements",
    description: "Milestones you and Imperator have unlocked",
  },
] as const;

/** Keys of AppSettings whose value is a boolean — the ones a switch can bind. */
type BooleanSettingKey = {
  [K in keyof AppSettings]: AppSettings[K] extends boolean ? K : never;
}[keyof AppSettings];

/** A labelled boolean preference row bound to the settings store. */
function ToggleRow({
  settingKey,
  label,
  description,
  value,
}: {
  settingKey: BooleanSettingKey;
  label: string;
  description: string;
  value: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 p-4">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <p className="mt-0.5 text-xs text-text-secondary">{description}</p>
      </div>
      <Switch
        checked={value}
        onCheckedChange={(checked) => setAppSetting(settingKey, checked === true)}
        aria-label={label}
      />
    </div>
  );
}

export default function SettingsPage() {
  const settings = useAppSettings();
  const saveStatus = useSaveStatus();
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
      {/* Quiet saved indicator — settings sync to the server automatically. */}
      <p
        className="flex items-center gap-1.5 self-end text-xs text-text-tertiary"
        aria-live="polite"
      >
        {saveStatus === "saving" ? (
          "Saving…"
        ) : saveStatus === "saved" ? (
          <>
            <Check className="size-3.5 text-success" /> Saved
          </>
        ) : (
          "Settings sync across your devices"
        )}
      </p>

      <Card className="flex flex-col divide-y divide-current/10 p-0">
        <div className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
          Preferences
        </div>
        <div className="flex items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <div className="text-sm font-medium">Density</div>
            <p className="mt-0.5 text-xs text-text-secondary">
              Compact tightens spacing across the app.
            </p>
          </div>
          <Segmented
            value={settings.density}
            onChange={(v) => setAppSetting("density", v as AppSettings["density"])}
            options={[
              { value: "comfortable", label: "Comfortable" },
              { value: "compact", label: "Compact" },
            ]}
          />
        </div>
        <div className="flex items-start justify-between gap-3 p-4">
          <div className="min-w-0">
            <div className="text-sm font-medium">Reduce motion</div>
            <p className="mt-0.5 text-xs text-text-secondary">
              Minimise animations and transitions, regardless of your OS setting.
            </p>
          </div>
          <Switch
            checked={settings.motion === "reduced"}
            onCheckedChange={(checked) =>
              setAppSetting("motion", checked === true ? "reduced" : "full")
            }
            aria-label="Reduce motion"
          />
        </div>
        <ToggleRow
          settingKey="sound"
          label="Sound on reply"
          description="Play a short cue when Imperator finishes a reply."
          value={settings.sound}
        />
        <ToggleRow
          settingKey="showToolCalls"
          label="Show tool activity"
          description="Render tool and system rows inline in the chat feed."
          value={settings.showToolCalls}
        />
        <ToggleRow
          settingKey="showTimestamps"
          label="Show timestamps"
          description="Show the time next to each chat message."
          value={settings.showTimestamps}
        />
        <ToggleRow
          settingKey="showTokenCost"
          label="Show token & cost"
          description="Surface token counts and cost readouts where available."
          value={settings.showTokenCost}
        />
      </Card>

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
