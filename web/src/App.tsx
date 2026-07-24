import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Routes,
  Route,
  NavLink,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  Activity,
  BarChart3,
  BookOpen,
  CalendarDays,
  Brain,
  BriefcaseBusiness,
  Clock,
  Code,
  Cpu,
  Database,
  Download,
  Eye,
  FolderOpen,
  FileText,
  GitBranch,
  Globe,
  Heart,
  KeyRound,
  Mail,
  Menu,
  MessageSquare,
  NotebookText,
  Music,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Puzzle,
  Radio,
  RotateCw,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  Terminal,
  Trophy,
  Users,
  Webhook,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { SelectionSwitcher } from "@nous-research/ui/ui/components/selection-switcher";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Typography } from "@nous-research/ui/ui/components/typography/index";
import { ConfirmDialog } from "@nous-research/ui/ui/components/confirm-dialog";
import { cn } from "@/lib/utils";
import {
  CommandPalette,
  type CommandPaletteItem,
} from "@/components/CommandPalette";
import { SidebarFooter } from "@/components/SidebarFooter";
import { SidebarStatusStrip, gatewayLine } from "@/components/SidebarStatusStrip";
import { useBelowBreakpoint } from "@nous-research/ui/hooks/use-below-breakpoint";
import { useSidebarStatus } from "@/hooks/useSidebarStatus";
import { AuthWidget } from "@/components/AuthWidget";
import { PageHeaderProvider } from "@/contexts/PageHeaderProvider";
import { ProfileProvider } from "@/contexts/ProfileProvider";
import { useProfileScope } from "@/contexts/useProfileScope";
import { ProfileSwitcher } from "@/components/ProfileSwitcher";
import { ProfileScopeBanner } from "@/components/ProfileScopeBanner";
import { useSystemActions } from "@/contexts/useSystemActions";
import type { SystemAction } from "@/contexts/system-actions-context";
// Every management page is code-split into its own chunk: the shell (and
// the phone's first paint) only pays for what it renders. ChatPage stays a
// static import on purpose — the persistent chat host mounts it on app
// load regardless of route, so splitting it would only add a fetch delay
// to the PTY spawn.
const ConfigPage = lazy(() => import("@/pages/ConfigPage"));
const DocsPage = lazy(() => import("@/pages/DocsPage"));
const EnvPage = lazy(() => import("@/pages/EnvPage"));
const FilesPage = lazy(() => import("@/pages/FilesPage"));
const GitPage = lazy(() => import("@/pages/GitPage"));
const LearningPage = lazy(() => import("@/pages/LearningPage"));
const JobsPage = lazy(() => import("@/pages/JobsPage"));
const ProgressPage = lazy(() => import("@/pages/ProgressPage"));
const SessionsPage = lazy(() => import("@/pages/SessionsPage"));
const LogsPage = lazy(() => import("@/pages/LogsPage"));
const AnalyticsPage = lazy(() => import("@/pages/AnalyticsPage"));
const ModelsPage = lazy(() => import("@/pages/ModelsPage"));
const CronPage = lazy(() => import("@/pages/CronPage"));
const ProfilesPage = lazy(() => import("@/pages/ProfilesPage"));
const ProfileBuilderPage = lazy(() => import("@/pages/ProfileBuilderPage"));
const SkillsPage = lazy(() => import("@/pages/SkillsPage"));
const PluginsPage = lazy(() => import("@/pages/PluginsPage"));
const McpPage = lazy(() => import("@/pages/McpPage"));
const PairingPage = lazy(() => import("@/pages/PairingPage"));
const ChannelsPage = lazy(() => import("@/pages/ChannelsPage"));
const WebhooksPage = lazy(() => import("@/pages/WebhooksPage"));
const SystemPage = lazy(() => import("@/pages/SystemPage"));
const SettingsPage = lazy(() => import("@/pages/SettingsPage"));
import ChatPage from "@/pages/ChatPage";
const MediaPage = lazy(() => import("@/features/media/MediaPage"));
const EmailPage = lazy(() => import("@/features/email/EmailPage"));
const CalendarPage = lazy(() => import("@/features/calendar/CalendarPage"));
const VaultPage = lazy(() => import("@/features/vault/VaultPage"));
import { MediaProvider } from "@/features/media/MediaProvider";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { useI18n } from "@/i18n";
import type { Translations } from "@/i18n/types";
import { PluginPage, PluginSlot, usePlugins } from "@/plugins";
import type { PluginManifest } from "@/plugins";
import { isDashboardEmbeddedChatEnabled } from "@/lib/dashboard-flags";
import {
  getAppSettings,
  hydrateAppSettings,
  setAppSetting,
  useAppSettings,
} from "@/lib/app-settings";
import { api } from "@/lib/api";
import type { StatusResponse, UpdateCheckResponse } from "@/lib/api";

function RootRedirect() {
  return <Navigate to="/sessions" replace />;
}

function UnknownRouteFallback({ pluginsLoading }: { pluginsLoading: boolean }) {
  if (pluginsLoading) {
    // Render nothing during the plugin-load window — a spinner here would just flash.
    return null;
  }
  return <Navigate to="/sessions" replace />;
}

const CHAT_NAV_ITEM: NavItem = {
  path: "/chat",
  labelKey: "chat",
  label: "Chat",
  icon: Terminal,
};

/**
 * Built-in routes except /chat.  Chat is rendered persistently (outside
 * <Routes>) when embedded — see the persistent chat host block rendered
 * inline near the bottom of this file — so the PTY child, WebSocket,
 * and xterm instance survive when the user visits another tab and comes
 * back.  A `display:none` toggle hides the terminal without unmounting.
 * Routing still owns the URL so /chat deep-links, browser back/forward,
 * and nav highlight keep working.
 */
const BUILTIN_ROUTES_CORE: Record<string, ComponentType> = {
  "/": RootRedirect,
  "/sessions": SessionsPage,
  "/media": MediaPage,
  "/email": EmailPage,
  "/calendar": CalendarPage,
  "/vault": VaultPage,
  "/jobs": JobsPage,
  "/progress": ProgressPage,
  "/files": FilesPage,
  "/git": GitPage,
  "/learning": LearningPage,
  "/analytics": AnalyticsPage,
  "/models": ModelsPage,
  "/logs": LogsPage,
  "/cron": CronPage,
  "/skills": SkillsPage,
  "/plugins": PluginsPage,
  "/mcp": McpPage,
  "/pairing": PairingPage,
  "/channels": ChannelsPage,
  "/webhooks": WebhooksPage,
  "/system": SystemPage,
  "/settings": SettingsPage,
  "/profiles": ProfilesPage,
  "/profiles/new": ProfileBuilderPage,
  "/config": ConfigPage,
  "/env": EnvPage,
  "/docs": DocsPage,
};

// Route placeholder for /chat.  The persistent ChatPage host (rendered
// outside <Routes> when embedded chat is on) paints on top; this empty
// element just claims the path so the `*` catch-all redirect doesn't
// fire when the user navigates to /chat.
function ChatRouteSink() {
  return null;
}

const BUILTIN_NAV_REST: NavItem[] = [
  {
    path: "/sessions",
    labelKey: "sessions",
    label: "Sessions",
    icon: MessageSquare,
  },
  { path: "/media", label: "Media", icon: Music },
  { path: "/email", label: "Email", icon: Mail },
  { path: "/calendar", label: "Calendar", icon: CalendarDays },
  { path: "/vault", label: "Vault", icon: NotebookText },
  { path: "/jobs", label: "Jobs", icon: BriefcaseBusiness },
  { path: "/progress", label: "Progress", icon: Activity },
  { path: "/files", label: "Files", icon: FolderOpen },
  { path: "/git", label: "Git", icon: GitBranch },
  {
    path: "/analytics",
    labelKey: "analytics",
    label: "Analytics",
    icon: BarChart3,
  },
  { path: "/logs", labelKey: "logs", label: "Logs", icon: FileText },
  { path: "/cron", labelKey: "cron", label: "Cron", icon: Clock },
  { path: "/skills", labelKey: "skills", label: "Skills", icon: Package },
  { path: "/learning", label: "Learning", icon: Brain },
  { path: "/plugins", labelKey: "plugins", label: "Plugins", icon: Puzzle },
  { path: "/mcp", label: "MCP", icon: Plug },
  { path: "/channels", label: "Channels", icon: Radio },
  { path: "/webhooks", label: "Webhooks", icon: Webhook },
  { path: "/pairing", label: "Pairing", icon: ShieldCheck },
  { path: "/profiles", labelKey: "profiles", label: "Profiles", icon: Users },
  { path: "/config", labelKey: "config", label: "Config", icon: Settings },
  { path: "/env", labelKey: "keys", label: "Keys", icon: KeyRound },
  { path: "/settings", label: "Settings", icon: SlidersHorizontal },
];

/**
 * Routes that are reachable only through the Settings hub, never as their
 * own sidebar or mobile-nav entry. Their pages/routes still exist (see
 * BUILTIN_ROUTES and the /achievements plugin) and SettingsPage links to
 * each — this set just keeps them out of the primary navigation so Settings
 * is the single home for models, system, docs, and achievements.
 */
const SETTINGS_ONLY_PATHS = new Set(["/models", "/system", "/docs", "/achievements"]);

/**
 * The settings-only destinations, re-exposed in the command palette so
 * power users can still jump straight to them (Cmd/Ctrl+K) even though they
 * no longer occupy a sidebar slot. Kept in sync with SETTINGS_ONLY_PATHS.
 */
const SETTINGS_ONLY_NAV: NavItem[] = [
  { path: "/models", labelKey: "models", label: "Models", icon: Cpu },
  { path: "/system", label: "System", icon: Wrench },
  { path: "/docs", labelKey: "documentation", label: "Documentation", icon: BookOpen },
  { path: "/achievements", label: "Achievements", icon: Trophy },
];

/**
 * Sidebar groupings for the built-in nav. Purely presentational — routing,
 * plugin insertion, and the analytics gate all still run off the flat
 * nav list; sections just cluster the rendered links so the sidebar reads
 * as a small set of scannable groups instead of an 18-item wall. Items the
 * sections don't claim (e.g. future additions) fall into the last group,
 * so nothing can silently disappear from navigation.
 */
const NAV_SECTIONS: Array<{
  id: string;
  /** Optional i18n key under t.app.navSections; label is the fallback. */
  labelKey?: "operate" | "automate" | "connect" | "settings";
  label: string;
  paths: string[];
}> = [
  {
    id: "operate",
    labelKey: "operate",
    label: "Operate",
    paths: ["/sessions", "/media", "/email", "/calendar", "/vault", "/jobs", "/progress", "/files", "/git", "/analytics", "/logs"],
  },
  {
    id: "automate",
    labelKey: "automate",
    label: "Automate",
    paths: ["/cron", "/skills", "/learning", "/plugins", "/mcp", "/webhooks"],
  },
  {
    id: "connect",
    labelKey: "connect",
    label: "Connect",
    paths: ["/channels", "/pairing", "/profiles"],
  },
  {
    // "Settings", not "System" — the sidebar's system-actions block below
    // the nav already carries a "System" heading.
    id: "settings",
    labelKey: "settings",
    label: "Settings",
    // Models, System, Documentation and Achievements deliberately do NOT
    // appear here — they live one level down, inside the Settings hub
    // (see SETTINGS_ONLY_PATHS and SettingsPage), keeping the sidebar to a
    // single "Settings" entry point for all admin/meta surfaces.
    paths: ["/settings", "/config", "/env"],
  },
];

const ICON_MAP: Record<string, ComponentType<{ className?: string }>> = {
  Activity,
  BarChart3,
  Clock,
  Cpu,
  FileText,
  FolderOpen,
  KeyRound,
  MessageSquare,
  Package,
  Settings,
  Puzzle,
  Sparkles,
  Terminal,
  Globe,
  Database,
  Shield,
  Users,
  Wrench,
  Zap,
  Heart,
  Star,
  Code,
  Eye,
};

function resolveIcon(name: string): ComponentType<{ className?: string }> {
  return ICON_MAP[name] ?? Puzzle;
}

function buildNavItems(
  builtIn: NavItem[],
  manifests: PluginManifest[],
): NavItem[] {
  const items = [...builtIn];

  for (const manifest of manifests) {
    if (manifest.tab.override) continue;
    if (manifest.tab.hidden) continue;

    const pluginItem: NavItem = {
      path: manifest.tab.path,
      label: manifest.label,
      icon: resolveIcon(manifest.icon),
    };

    const pos = manifest.tab.position ?? "end";
    if (pos === "end") {
      items.push(pluginItem);
    } else if (pos.startsWith("after:")) {
      const target = "/" + pos.slice(6);
      const idx = items.findIndex((i) => i.path === target);
      items.splice(idx >= 0 ? idx + 1 : items.length, 0, pluginItem);
    } else if (pos.startsWith("before:")) {
      const target = "/" + pos.slice(7);
      const idx = items.findIndex((i) => i.path === target);
      items.splice(idx >= 0 ? idx : items.length, 0, pluginItem);
    } else {
      items.push(pluginItem);
    }
  }

  return items;
}

/** Split merged nav into built-in sidebar entries vs plugin tabs, preserving plugin order hints. */
function partitionSidebarNav(
  builtIn: NavItem[],
  manifests: PluginManifest[],
): { coreItems: NavItem[]; pluginItems: NavItem[] } {
  const merged = buildNavItems(builtIn, manifests);
  const builtinPaths = new Set(builtIn.map((i) => i.path));
  // Plugin pages a NAV_SECTIONS entry claims render inside that section like
  // a built-in; only truly unclaimed plugin pages fall into the separate
  // plugin cluster.
  const sectionClaimed = new Set(NAV_SECTIONS.flatMap((s) => s.paths));
  const coreItems: NavItem[] = [];
  const pluginItems: NavItem[] = [];
  for (const item of merged) {
    // Settings-only surfaces (models/system/docs/achievements) are reached
    // through the Settings hub, so they never render in the sidebar — even
    // the /achievements plugin, which would otherwise land in the plugin
    // cluster.
    if (SETTINGS_ONLY_PATHS.has(item.path)) continue;
    if (builtinPaths.has(item.path) || sectionClaimed.has(item.path)) {
      coreItems.push(item);
    } else {
      pluginItems.push(item);
    }
  }
  return { coreItems, pluginItems };
}

function buildRoutes(
  builtinRoutes: Record<string, ComponentType>,
  manifests: PluginManifest[],
): Array<{
  key: string;
  path: string;
  element: ReactNode;
}> {
  const byOverride = new Map<string, PluginManifest>();
  const addons: PluginManifest[] = [];

  for (const m of manifests) {
    if (m.tab.override) {
      byOverride.set(m.tab.override, m);
    } else {
      addons.push(m);
    }
  }

  const routes: Array<{
    key: string;
    path: string;
    element: ReactNode;
  }> = [];

  for (const [path, Component] of Object.entries(builtinRoutes)) {
    const om = byOverride.get(path);
    if (om) {
      routes.push({
        key: `override:${om.name}`,
        path,
        element: <PluginPage name={om.name} />,
      });
    } else {
      routes.push({ key: `builtin:${path}`, path, element: <Component /> });
    }
  }

  for (const m of addons) {
    if (m.tab.hidden) continue;
    if (m.tab.path === "/plugins") continue;
    if (builtinRoutes[m.tab.path]) continue;
    routes.push({
      key: `plugin:${m.name}`,
      path: m.tab.path,
      element: <PluginPage name={m.name} />,
    });
  }

  for (const m of manifests) {
    if (!m.tab.hidden) continue;
    if (m.tab.path === "/plugins") continue;
    if (builtinRoutes[m.tab.path] || m.tab.override) continue;
    routes.push({
      key: `plugin:hidden:${m.name}`,
      path: m.tab.path,
      element: <PluginPage name={m.name} />,
    });
  }

  return routes;
}

export default function App() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { manifests, loading: pluginsLoading } = usePlugins();
  const [mobileOpen, setMobileOpen] = useState(false);
  const closeMobile = useCallback(() => setMobileOpen(false), []);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Native-style touch gestures: swipe in from the left edge to open the
  // navigation drawer; swipe left while it's open to close it. Vertical
  // movement cancels the gesture so list scrolling never fights it, and
  // touches inside a terminal pane are ignored entirely.
  const mobileOpenRef = useRef(mobileOpen);
  useEffect(() => {
    mobileOpenRef.current = mobileOpen;
  }, [mobileOpen]);
  useEffect(() => {
    let startX = 0;
    let startY = 0;
    let tracking: "open" | "close" | null = null;

    const onTouchStart = (event: TouchEvent) => {
      tracking = null;
      if (window.innerWidth >= 1024) return;
      const touch = event.touches[0];
      if (!touch) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".xterm, .hermes-chat-xterm-host")) return;
      startX = touch.clientX;
      startY = touch.clientY;
      if (mobileOpenRef.current) tracking = "close";
      else if (touch.clientX <= 24) tracking = "open";
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!tracking) return;
      const touch = event.touches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Math.abs(dy) > 60) {
        tracking = null;
        return;
      }
      if (tracking === "open" && dx > 56) {
        setMobileOpen(true);
        tracking = null;
      } else if (tracking === "close" && dx < -56) {
        setMobileOpen(false);
        tracking = null;
      }
    };

    const onTouchEnd = () => {
      tracking = null;
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, []);

  // Keyboard-aware app height. iOS Safari overlays the software keyboard
  // instead of resizing the layout viewport, hiding anything anchored to
  // the bottom (the chat composer, the tab bar). Track the visual
  // viewport and pin the shell to its height while a keyboard is up so
  // bottom chrome stays visible above it. Android/Chrome resizes the
  // viewport itself (interactive-widget=resizes-content), so the
  // threshold keeps this a no-op there.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const update = () => {
      const keyboardHeight = window.innerHeight - viewport.height;
      if (keyboardHeight > 80) {
        root.style.setProperty("--app-vvh", `${viewport.height}px`);
        // The media mini-player is fixed to the layout viewport, so it's
        // hidden behind the software keyboard — the composer must stop
        // reserving space for it while the keyboard is up.
        root.dataset.keyboard = "open";
      } else {
        root.style.removeProperty("--app-vvh");
        delete root.dataset.keyboard;
      }
    };
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    update();
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      root.style.removeProperty("--app-vvh");
      delete root.dataset.keyboard;
    };
  }, []);

  // ⌘K / Ctrl+K opens the command palette from anywhere in the app —
  // except inside a terminal pane, where Ctrl+K is a real shell binding
  // (kill-line) that must reach the PTY, not the palette.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "k"
      ) {
        const target = event.target as HTMLElement | null;
        if (target?.closest?.(".xterm, .hermes-chat-xterm-host")) return;
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Settings are server-persisted (survive reload / new browser / device);
  // hydrate once on mount, then apply the ones with a visual effect.
  const appSettings = useAppSettings();
  useEffect(() => {
    void hydrateAppSettings();
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty(
      "--theme-spacing-mul",
      appSettings.density === "compact" ? "0.9" : "1",
    );
    root.dataset.density = appSettings.density;
    if (appSettings.motion === "reduced") root.dataset.motion = "reduced";
    else delete root.dataset.motion;
  }, [appSettings.density, appSettings.motion]);

  const collapsed = appSettings.sidebarCollapsed;
  const toggleCollapsed = useCallback(() => {
    setAppSetting("sidebarCollapsed", !collapsed);
  }, [collapsed]);
  const isMobile = useBelowBreakpoint(1024);
  const isDesktopCollapsed = collapsed && !isMobile;
  const tooltipWarmRef = useRef(0);
  const sidebarStatus = useSidebarStatus();
  const isDocsRoute = pathname === "/docs" || pathname === "/docs/";
  const normalizedPath = pathname.replace(/\/$/, "") || "/";
  const isChatRoute = normalizedPath === "/chat";
  const embeddedChat = isDashboardEmbeddedChatEnabled();

  // `dashboard.show_token_analytics` gates the Analytics nav item.  The
  // page itself remains reachable by URL (it renders an explanation when
  // the flag is off — see AnalyticsPage), but hiding the nav entry avoids
  // surfacing misleading token/cost numbers in the sidebar.  Default off.
  const [showTokenAnalytics, setShowTokenAnalytics] = useState(false);
  useEffect(() => {
    api
      .getConfig()
      .then((cfg) => {
        const dash = (cfg?.dashboard ?? {}) as {
          show_token_analytics?: unknown;
        };
        setShowTokenAnalytics(dash.show_token_analytics === true);
      })
      .catch(() => setShowTokenAnalytics(false));
  }, []);

  // A plugin can replace the built-in /chat page via `tab.override: "/chat"`
  // in its manifest.  When one does, `buildRoutes` already swaps the route
  // element for <PluginPage /> — but we also have to suppress the
  // persistent ChatPage host below, or the plugin's page and the built-in
  // terminal would paint on top of each other.  The override is niche
  // (nothing ships overriding /chat today) but it's an advertised
  // extension point, so preserve the pre-persistence contract: when a
  // plugin owns /chat, the built-in chat UI is entirely absent.
  //
  // Waiting on `pluginsLoading` is load-bearing: manifests arrive
  // asynchronously from /api/dashboard/plugins, so on initial render
  // `chatOverriddenByPlugin` is always false.  Without the loading
  // gate, the persistent host would mount, spawn a PTY, and THEN get
  // yanked out from under the user when the plugin's manifest resolves
  // — killing the session mid-paint.  Delaying host mount by the
  // plugin-load window (typically <50ms, worst case 2s safety timeout)
  // is the cheaper trade-off.
  const chatOverriddenByPlugin = useMemo(
    () => manifests.some((m) => m.tab.override === "/chat"),
    [manifests],
  );

  const builtinRoutes = useMemo(
    () => ({
      ...BUILTIN_ROUTES_CORE,
      ...(embeddedChat ? { "/chat": ChatRouteSink } : {}),
    }),
    [embeddedChat],
  );

  const builtinNav = useMemo(() => {
    const base = embeddedChat
      ? [CHAT_NAV_ITEM, ...BUILTIN_NAV_REST]
      : BUILTIN_NAV_REST;
    return showTokenAnalytics
      ? base
      : base.filter((n) => n.path !== "/analytics");
  }, [embeddedChat, showTokenAnalytics]);

  const sidebarNav = useMemo(
    () => partitionSidebarNav(builtinNav, manifests),
    [builtinNav, manifests],
  );
  const routes = useMemo(
    () => buildRoutes(builtinRoutes, manifests),
    [builtinRoutes, manifests],
  );
  const pluginTabMeta = useMemo(
    () =>
      manifests
        .filter((m) => !m.tab.hidden)
        .map((m) => ({
          path: m.tab.override ?? m.tab.path,
          label: m.label,
        })),
    [manifests],
  );

  // Every navigation destination becomes a palette item; the section name
  // doubles as a hint and extra fuzzy-matchable text.
  const paletteItems = useMemo<CommandPaletteItem[]>(() => {
    const sectionOf = (path: string): string | undefined => {
      for (const section of NAV_SECTIONS) {
        if (section.paths.includes(path)) {
          return section.labelKey
            ? (t.app.navSections?.[section.labelKey] ?? section.label)
            : section.label;
        }
      }
      return undefined;
    };
    const navLabel = (item: NavItem) =>
      item.labelKey
        ? ((t.app.nav as Record<string, string>)[item.labelKey] ?? item.label)
        : item.label;
    const toItem = (item: NavItem, hint?: string): CommandPaletteItem => ({
      id: item.path,
      label: navLabel(item),
      hint,
      keywords: hint,
      icon: item.icon,
      run: () => {
        navigate(item.path);
        closeMobile();
      },
    });
    const settingsHint = t.app.navSections?.settings ?? "Settings";

    // Action commands — the palette isn't only a page jumper; the row and
    // settings actions that otherwise need a mouse are reachable here too, so
    // a keyboard/screen-reader user can drive the whole app from ⌘K. Labels
    // reflect the current state so the outcome is unambiguous before running.
    const actionHint = "Action";
    const s = appSettings;
    const actionItems: CommandPaletteItem[] = [
      {
        id: "action:new-chat",
        label: "Start new chat",
        hint: actionHint,
        keywords: "new chat conversation session fresh compose",
        icon: MessageSquare,
        run: () => {
          navigate("/chat");
          closeMobile();
        },
      },
      {
        id: "action:toggle-density",
        label: s.density === "compact" ? "Use comfortable density" : "Use compact density",
        hint: actionHint,
        keywords: "density compact comfortable spacing layout",
        icon: SlidersHorizontal,
        run: () =>
          setAppSetting(
            "density",
            getAppSettings().density === "compact" ? "comfortable" : "compact",
          ),
      },
      {
        id: "action:toggle-motion",
        label: s.motion === "reduced" ? "Allow motion and animations" : "Reduce motion",
        hint: actionHint,
        keywords: "motion animation reduce accessibility",
        icon: Zap,
        run: () =>
          setAppSetting(
            "motion",
            getAppSettings().motion === "reduced" ? "full" : "reduced",
          ),
      },
      {
        id: "action:toggle-notifications",
        label: s.notificationsEnabled ? "Disable reply notifications" : "Enable reply notifications",
        hint: actionHint,
        keywords: "notifications browser push replies alerts",
        icon: Radio,
        run: () => setAppSetting("notificationsEnabled", !getAppSettings().notificationsEnabled),
      },
      {
        id: "action:toggle-tool-activity",
        label: s.showToolCalls ? "Hide tool activity in chat" : "Show tool activity in chat",
        hint: actionHint,
        keywords: "tool calls activity system rows chat feed",
        icon: Wrench,
        run: () => setAppSetting("showToolCalls", !getAppSettings().showToolCalls),
      },
      {
        id: "action:toggle-timestamps",
        label: s.showTimestamps ? "Hide message timestamps" : "Show message timestamps",
        hint: actionHint,
        keywords: "timestamps time chat feed",
        icon: Clock,
        run: () => setAppSetting("showTimestamps", !getAppSettings().showTimestamps),
      },
      {
        id: "action:toggle-token-cost",
        label: s.showTokenCost ? "Hide token and cost readouts" : "Show token and cost readouts",
        hint: actionHint,
        keywords: "token cost usage readout",
        icon: SlidersHorizontal,
        run: () => setAppSetting("showTokenCost", !getAppSettings().showTokenCost),
      },
      {
        id: "action:toggle-sound",
        label: s.sound ? "Mute reply sound cue" : "Play a sound on reply",
        hint: actionHint,
        keywords: "sound audio cue chime reply",
        icon: Music,
        run: () => setAppSetting("sound", !getAppSettings().sound),
      },
      {
        id: "action:toggle-sidebar",
        label: s.sidebarCollapsed ? "Expand the sidebar" : "Collapse the sidebar",
        hint: actionHint,
        keywords: "sidebar collapse expand rail navigation",
        icon: s.sidebarCollapsed ? PanelLeftOpen : PanelLeftClose,
        run: () => setAppSetting("sidebarCollapsed", !getAppSettings().sidebarCollapsed),
      },
    ];

    return [
      ...sidebarNav.coreItems.map((item) =>
        toItem(item, item.path === "/chat" ? undefined : sectionOf(item.path)),
      ),
      ...sidebarNav.pluginItems.map((item) =>
        toItem(item, t.app.pluginNavSection),
      ),
      // Settings-only pages keep a palette entry even though they're no
      // longer in the sidebar.
      ...SETTINGS_ONLY_NAV.map((item) => toItem(item, settingsHint)),
      ...actionItems,
    ];
  }, [sidebarNav, t, navigate, closeMobile, appSettings]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [mobileOpen]);

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setMobileOpen(false);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return (
    <ProfileProvider>
    <MediaProvider>
    <div
      data-layout-variant="standard"
      className="imperator-canvas flex h-dvh max-h-dvh min-h-0 flex-col overflow-hidden bg-background-base text-text-primary antialiased"
      style={{
        height: "var(--app-vvh, 100dvh)",
        maxHeight: "var(--app-vvh, 100dvh)",
      }}
    >
      <SelectionSwitcher />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={paletteItems}
      />

      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0"
      >
        <PluginSlot name="backdrop" />
      </div>

      <header
        className={cn(
          "lg:hidden fixed top-0 left-0 right-0 z-40 min-h-14",
          "flex items-center gap-2 px-4 py-2",
          "border-b border-current/20",
          // Translucent blurred chrome — the native mobile-app bar look.
          // Solid fallback where backdrop-filter is unsupported.
          "bg-background-base supports-[backdrop-filter]:bg-background-base/75 supports-[backdrop-filter]:backdrop-blur-xl",
        )}
      >
        {/* One drawer affordance per screen: the bottom tab bar's Menu is
            it everywhere except /chat, where the bar is hidden and this
            hamburger takes over. */}
        {isChatRoute && (
          <Button
            ghost
            size="icon"
            onClick={() => setMobileOpen(true)}
            aria-label={t.app.openNavigation}
            aria-expanded={mobileOpen}
            aria-controls="app-sidebar"
            className="text-text-secondary hover:text-midground"
          >
            <Menu />
          </Button>
        )}

        <Typography className="font-bold text-[0.95rem] leading-[0.95] tracking-[0.09em] text-midground uppercase">
          {t.app.brand}
        </Typography>

        <Button
          ghost
          size="icon"
          onClick={() => setPaletteOpen(true)}
          aria-label="Search pages"
          className="ml-auto text-text-secondary hover:text-midground"
        >
          <Search />
        </Button>
      </header>

      {mobileOpen && (
        <Button
          ghost
          aria-label={t.app.closeNavigation}
          onClick={closeMobile}
          className={cn(
            "lg:hidden fixed inset-0 z-40 p-0 block",
            "bg-black/70",
          )}
        />
      )}

      <PluginSlot name="header-banner" />
      <ProfileScopeBanner />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pt-14 lg:pt-0">
        <div className="flex min-h-0 min-w-0 flex-1">
          <aside
            id="app-sidebar"
            aria-label={t.app.navigation}
            className={cn(
              "fixed top-0 left-0 z-50 flex h-dvh max-h-dvh w-64 min-h-0 flex-col font-sans",
              "border-r border-current/20",
              "bg-background-base",
              "transition-[transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]",
              mobileOpen ? "translate-x-0" : "-translate-x-full",
              "lg:sticky lg:top-0 lg:translate-x-0 lg:shrink-0 lg:overflow-hidden",
              "lg:transition-[width] lg:duration-300 lg:ease-[cubic-bezier(0.23,1,0.32,1)]",
              collapsed && "lg:w-14",
            )}
          >
            <div
              className={cn(
                "flex h-14 shrink-0 items-center gap-2",
                "border-b border-current/20",
                collapsed ? "lg:justify-center lg:px-0" : "px-4 justify-between",
              )}
            >
              <div
                className={cn(
                  "flex items-center gap-2",
                  collapsed && "lg:hidden",
                )}
              >
                <PluginSlot name="header-left" />

                <Typography className="font-bold text-[1.125rem] leading-[0.95] tracking-[0.09em] text-midground uppercase">
                  {t.app.brand}
                </Typography>
              </div>

              <Button
                ghost
                size="icon"
                onClick={closeMobile}
                aria-label={t.app.closeNavigation}
                className="lg:hidden text-text-secondary hover:text-midground"
              >
                <X />
              </Button>

              <Button
                ghost
                size="icon"
                onClick={toggleCollapsed}
                aria-label={
                  collapsed ? t.common.expand : t.common.collapse
                }
                className="hidden lg:flex text-text-secondary hover:text-midground"
              >
                {collapsed ? (
                  <PanelLeftOpen className="h-4 w-4" />
                ) : (
                  <PanelLeftClose className="h-4 w-4" />
                )}
              </Button>
            </div>

            <ProfileSwitcher collapsed={isDesktopCollapsed} />

            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Search pages (Ctrl+K)"
              className={cn(
                "mx-3 my-2 flex shrink-0 items-center gap-2 rounded border border-current/15 px-2.5 py-1.5",
                "text-xs text-text-tertiary transition-colors cursor-pointer",
                "hover:border-current/30 hover:text-midground",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground",
                isDesktopCollapsed && "lg:mx-auto lg:border-transparent lg:px-1.5",
              )}
            >
              <Search className="h-3.5 w-3.5 shrink-0" />
              <span
                className={cn(
                  "flex-1 text-left",
                  isDesktopCollapsed && "lg:hidden",
                )}
              >
                {t.app.searchLabel ?? "Search"}
              </span>
              <kbd
                className={cn(
                  "rounded border border-current/20 px-1 text-xs",
                  isDesktopCollapsed && "lg:hidden",
                )}
              >
                ⌘K
              </kbd>
            </button>

            <nav
              className="min-h-0 w-full flex-1 overflow-y-auto overflow-x-hidden border-t border-current/10 py-2"
              aria-label={t.app.navigation}
            >
              <GroupedCoreNav
                closeMobile={closeMobile}
                collapsed={isDesktopCollapsed}
                items={sidebarNav.coreItems}
                t={t}
                tooltipWarmRef={tooltipWarmRef}
              />

              {sidebarNav.pluginItems.length > 0 && (
                <div
                  aria-labelledby="hermes-sidebar-plugin-nav-heading"
                  className="flex flex-col border-t border-current/10 pb-2"
                  role="group"
                >
                  <span
                    className={cn(
                      "px-5 pt-2.5 pb-1",
                      "font-sans text-display text-xs tracking-[0.12em] text-text-tertiary",
                      isDesktopCollapsed && "lg:hidden",
                    )}
                    id="hermes-sidebar-plugin-nav-heading"
                  >
                    {t.app.pluginNavSection}
                  </span>

                  <ul className="flex flex-col">
                    {sidebarNav.pluginItems.map((item) => (
                      <SidebarNavLink
                        closeMobile={closeMobile}
                        collapsed={isDesktopCollapsed}
                        item={item}
                        key={item.path}
                        t={t}
                        tooltipWarmRef={tooltipWarmRef}
                      />
                    ))}
                  </ul>
                </div>
              )}
            </nav>

            <SidebarSystemActions
              collapsed={isDesktopCollapsed}
              onNavigate={closeMobile}
              status={sidebarStatus}
              tooltipWarmRef={tooltipWarmRef}
            />

            <div
              className={cn(
                "flex shrink-0 items-center gap-2",
                "px-3 py-2",
                "border-t border-current/20",
                isDesktopCollapsed
                  ? "lg:flex-col lg:items-start lg:gap-3 lg:py-3"
                  : "justify-between",
              )}
            >
              <div
                className={cn(
                  "flex min-w-0 items-center gap-2",
                  isDesktopCollapsed && "lg:flex-col lg:items-start",
                )}
              >
                <PluginSlot name="header-right" />

                <SidebarIconWithTooltip
                  collapsed={isDesktopCollapsed}
                  label={t.language.switchTo}
                  tooltipWarmRef={tooltipWarmRef}
                >
                  <LanguageSwitcher collapsed={isDesktopCollapsed} dropUp />
                </SidebarIconWithTooltip>
              </div>
            </div>

            <div
              className={cn(
                "flex shrink-0 flex-col",
                isDesktopCollapsed && "lg:hidden",
              )}
            >
              <AuthWidget />
              <SidebarFooter status={sidebarStatus} />
            </div>
          </aside>

          <PageHeaderProvider pluginTabs={pluginTabMeta}>
            <div
              className={cn(
                "relative z-2 flex min-w-0 min-h-0 flex-1 flex-col",
                // Chat is edge-to-edge on phones (flat, Claude-style, so the
                // keyboard slides against a seamless sheet) and insets to a
                // card at ≥sm where the side panel appears.
                isChatRoute ? "px-0 sm:px-6" : "px-3 sm:px-6",
                isChatRoute
                  ? "pb-0 pt-0 sm:pt-2 lg:pt-4"
                  : "pt-2 sm:pt-4 lg:pt-6",
                isDocsRoute && "min-h-0 flex-1",
              )}
            >
              <PluginSlot name="pre-main" />
              <div
                className={cn(
                  "w-full min-w-0",
                  // Non-chat pages reserve space for the tab bar + mini-player
                  // (heights measured at runtime). Chat handles its own
                  // bottom inset on the composer so it can float flush above
                  // the mini-player with no dead gap.
                  !isChatRoute && "media-dock-inset",
                  (isDocsRoute || isChatRoute) &&
                    "min-h-0 flex flex-1 flex-col",
                )}
              >
                <ProfileKeyedRoutes>
                  {/* Lazy page chunks resolve in tens of ms from the local
                      server; a centered spinner covers the gap without a
                      layout flash. */}
                  <Suspense
                    fallback={
                      <div
                        className="flex min-h-40 flex-1 items-center justify-center"
                        aria-busy="true"
                      >
                        <Spinner />
                      </div>
                    }
                  >
                    <Routes>
                      {routes.map(({ key, path, element }) => (
                        <Route key={key} path={path} element={element} />
                      ))}
                      <Route
                        path="*"
                        element={
                          <UnknownRouteFallback pluginsLoading={pluginsLoading} />
                        }
                      />
                    </Routes>
                  </Suspense>
                </ProfileKeyedRoutes>

                {embeddedChat &&
                  !chatOverriddenByPlugin &&
                  (pluginsLoading ? (
                    isChatRoute ? (
                      <div
                        className="flex min-h-0 min-w-0 flex-1 items-center justify-center"
                        aria-busy="true"
                        aria-live="polite"
                      >
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Spinner />
                          <span>Loading chat…</span>
                        </div>
                      </div>
                    ) : null
                  ) : (
                    <div
                      data-chat-active={isChatRoute ? "true" : "false"}
                      className={cn(
                        "min-h-0 min-w-0",
                        isChatRoute ? "flex flex-1 flex-col" : "hidden",
                      )}
                      aria-hidden={!isChatRoute}
                    >
                      <ChatPage isActive={isChatRoute} />
                    </div>
                  ))}
              </div>
              <PluginSlot name="post-main" />
            </div>
          </PageHeaderProvider>
        </div>
      </div>

      {!isChatRoute && !mobileOpen && (
        <MobileBottomNav
          items={builtinNav}
          onOpenMenu={() => setMobileOpen(true)}
          t={t}
        />
      )}

      <PluginSlot name="overlay" />
    </div>
    </MediaProvider>
    </ProfileProvider>
  );
}

/** Primary destinations surfaced in the mobile bottom tab bar. Everything
 *  else stays one tap away behind the Menu drawer. */
const MOBILE_PRIMARY_PATHS = ["/chat", "/sessions", "/channels", "/settings"];

/**
 * Fixed bottom tab bar on phone/tablet widths — the modern mobile-nav
 * pattern: 3–4 primary destinations always one thumb-tap away, plus a
 * Menu tab that opens the full navigation drawer. Hidden on desktop
 * (sidebar takes over) and on /chat (the terminal + software keyboard
 * need the full viewport height there).
 */
function MobileBottomNav({
  items,
  onOpenMenu,
  t,
}: {
  items: NavItem[];
  onOpenMenu: () => void;
  t: Translations;
}) {
  const primary = MOBILE_PRIMARY_PATHS.map((p) =>
    items.find((i) => i.path === p),
  ).filter((i): i is NavItem => Boolean(i));

  // Publish the tab bar's real height so the media mini-player can dock
  // directly above it (Spotify-style) and routed content clears both.
  // `lg:hidden` makes this 0 on desktop, so the dock falls to the bottom.
  const navRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = navRef.current;
    const root = document.documentElement;
    if (!node) return;
    const sync = () => {
      const h = node.offsetHeight;
      root.style.setProperty("--app-bottom-nav-h", `${h}px`);
      if (h > 0) root.dataset.mobileNav = "visible";
      else delete root.dataset.mobileNav;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => {
      observer.disconnect();
      root.style.setProperty("--app-bottom-nav-h", "0px");
      delete root.dataset.mobileNav;
    };
  }, []);

  const linkClass = (isActive: boolean) =>
    cn(
      "relative flex min-h-[3.25rem] w-full flex-col items-center justify-center gap-0.5 px-1 py-1.5",
      "font-sans text-display text-xs tracking-[0.06em]",
      "transition-[color,opacity] cursor-pointer",
      // Instant tactile feedback on tap, like a native tab bar.
      "active:opacity-60",
      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground",
      isActive ? "text-midground" : "text-text-secondary",
    );

  return (
    <nav
      ref={navRef}
      aria-label={t.app.navigation}
      className={cn(
        "lg:hidden fixed bottom-0 left-0 right-0 z-40",
        "border-t border-current/20",
        // Translucent blurred tab bar (iOS-style); solid fallback.
        "bg-background-base supports-[backdrop-filter]:bg-background-base/75 supports-[backdrop-filter]:backdrop-blur-xl",
        "pb-[env(safe-area-inset-bottom,0px)]",
      )}
    >
      <ul className="flex items-stretch">
        {primary.map((item) => {
          const { icon: Icon, label, labelKey, path } = item;
          const navLabel = labelKey
            ? ((t.app.nav as Record<string, string>)[labelKey] ?? label)
            : label;
          return (
            <li key={path} className="min-w-0 flex-1">
              <NavLink
                to={path}
                end={path === "/sessions"}
                className={({ isActive }) => linkClass(isActive)}
              >
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <span
                        aria-hidden
                        className="absolute left-1/2 top-0 h-0.5 w-8 -translate-x-1/2 bg-midground"
                      />
                    )}
                    <Icon className="h-4.5 w-4.5 shrink-0" />
                    <span className="max-w-full truncate">{navLabel}</span>
                  </>
                )}
              </NavLink>
            </li>
          );
        })}

        <li className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onOpenMenu}
            aria-label={t.app.openNavigation}
            className={linkClass(false)}
          >
            <Menu className="h-4.5 w-4.5 shrink-0" />
            <span className="max-w-full truncate">
              {t.app.navSections?.menu ?? "Menu"}
            </span>
          </button>
        </li>
      </ul>
    </nav>
  );
}

/**
 * Remounts the entire routed page tree when the global management profile
 * changes. Pages load their data on mount; without this, a page opened
 * under profile A would keep showing A's state while writes (via the
 * fetchJSON ?profile= injection) silently targeted the newly selected
 * profile B — the exact stale-target footgun the switcher exists to kill.
 * Keying by profile resets every page's local state so it refetches under
 * the new scope. The persistent ChatPage host below handles its own
 * remount (channel keyed on scopedProfile).
 */
function ProfileKeyedRoutes({ children }: { children: ReactNode }) {
  const { profile } = useProfileScope();
  return <div key={profile || "__own__"} className="contents">{children}</div>;
}

/**
 * Renders the built-in nav items clustered under the NAV_SECTIONS
 * headings. Chat (when present) stays pinned above the first section;
 * items no section claims fall into the final group so new routes are
 * always reachable even before they're categorized.
 */
function GroupedCoreNav({
  closeMobile,
  collapsed,
  items,
  t,
  tooltipWarmRef,
}: GroupedCoreNavProps) {
  const byPath = new Map(items.map((i) => [i.path, i]));
  const claimed = new Set<string>(["/chat"]);
  for (const section of NAV_SECTIONS) {
    for (const p of section.paths) claimed.add(p);
  }
  const unclaimed = items.filter((i) => !claimed.has(i.path));

  const chatItem = byPath.get("/chat");

  const renderItem = (item: NavItem) => (
    <SidebarNavLink
      closeMobile={closeMobile}
      collapsed={collapsed}
      item={item}
      key={item.path}
      t={t}
      tooltipWarmRef={tooltipWarmRef}
    />
  );

  return (
    <>
      {chatItem && <ul className="flex flex-col">{renderItem(chatItem)}</ul>}

      {NAV_SECTIONS.map((section, index) => {
        const sectionItems = section.paths
          .map((p) => byPath.get(p))
          .filter((i): i is NavItem => Boolean(i));
        if (index === NAV_SECTIONS.length - 1) {
          sectionItems.push(...unclaimed);
        }
        if (sectionItems.length === 0) return null;

        const heading = section.labelKey
          ? (t.app.navSections?.[section.labelKey] ?? section.label)
          : section.label;

        return (
          <div
            className={cn(
              "flex flex-col pb-1",
              // Collapsed rail hides headings — keep a hairline so the
              // groups still read as groups.
              collapsed && "lg:border-t lg:border-current/10",
            )}
            key={section.id}
          >
            <span
              className={cn(
                "px-5 pt-3 pb-1",
                "font-sans text-display text-xs tracking-[0.12em] text-text-tertiary",
                collapsed && "lg:hidden",
              )}
            >
              {heading}
            </span>

            <ul className="flex flex-col">{sectionItems.map(renderItem)}</ul>
          </div>
        );
      })}
    </>
  );
}

function SidebarNavLink({
  closeMobile,
  collapsed,
  item,
  tooltipWarmRef,
  t,
}: SidebarNavLinkProps) {
  const { path, label, labelKey, icon: Icon } = item;
  const [hovered, setHovered] = useState(false);
  const [tooltipAnchor, setTooltipAnchor] = useState<HTMLElement | null>(null);

  const navLabel = labelKey
    ? ((t.app.nav as Record<string, string>)[labelKey] ?? label)
    : label;
  const showTooltip = (event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
    setHovered(true);
    setTooltipAnchor(event.currentTarget);
  };
  const hideTooltip = () => {
    setHovered(false);
    setTooltipAnchor(null);
  };

  return (
    <li
      onMouseEnter={collapsed ? showTooltip : undefined}
      onMouseLeave={collapsed ? hideTooltip : undefined}
    >
      <NavLink
        to={path}
        end={path === "/sessions"}
        onClick={closeMobile}
        aria-label={collapsed ? navLabel : undefined}
        onFocus={collapsed ? showTooltip : undefined}
        onBlur={collapsed ? hideTooltip : undefined}
        className={({ isActive }) =>
          cn(
            "group/nav relative flex items-center gap-3",
            "px-5 py-2.5",
            "font-sans text-display uppercase text-sm tracking-[0.12em]",
            "whitespace-nowrap transition-colors cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground",
            isActive
              ? "text-midground"
              : "text-text-secondary hover:text-midground",
          )
        }
      >
        {({ isActive }) => (
          <>
            <Icon className="h-3.5 w-3.5 shrink-0" />

            <span
              className={cn(
                "truncate transition-opacity duration-300",
                collapsed ? "lg:opacity-0" : "lg:opacity-100",
              )}
            >
              {navLabel}
            </span>

            <span
              aria-hidden
              className="absolute inset-y-0.5 left-1.5 right-1.5 bg-midground opacity-0 pointer-events-none transition-opacity duration-200 group-hover/nav:opacity-5"
            />

            {isActive && (
              <span
                aria-hidden
                className="absolute left-0 top-0 bottom-0 w-px bg-midground"
              />
            )}
          </>
        )}
      </NavLink>

      {collapsed && hovered && tooltipAnchor && (
        <SidebarTooltip anchor={tooltipAnchor} label={navLabel} warmRef={tooltipWarmRef} />
      )}
    </li>
  );
}

function SidebarSystemActions({
  collapsed,
  onNavigate,
  status,
  tooltipWarmRef,
}: SidebarSystemActionsProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { activeAction, isBusy, isRunning, pendingAction, runAction } =
    useSystemActions();
  const canUpdateHermes = status?.can_update_hermes === true;
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const [updateConfirmOpen, setUpdateConfirmOpen] = useState(false);
  const [updateConfirmInfo, setUpdateConfirmInfo] =
    useState<UpdateCheckResponse | null>(null);
  const [updateConfirmChecking, setUpdateConfirmChecking] = useState(false);

  useEffect(() => {
    if (!updateConfirmOpen) {
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setUpdateConfirmChecking(true);
    });
    api
      .checkHermesUpdate(false)
      .then((info) => {
        if (!cancelled) setUpdateConfirmInfo(info);
      })
      .catch(() => {
        if (!cancelled) setUpdateConfirmInfo(null);
      })
      .finally(() => {
        if (!cancelled) setUpdateConfirmChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [updateConfirmOpen]);

  const updateConfirmDescription = useMemo(() => {
    if (updateConfirmInfo?.behind && updateConfirmInfo.behind > 0) {
      const cmd = updateConfirmInfo.update_command;
      const n = updateConfirmInfo.behind;
      return `This will run 'hermes update' (${cmd}) and pull ${n} new commit${n === 1 ? "" : "s"}. The gateway restarts when the update finishes; the current session keeps its prompt cache until then.`;
    }
    const cmd = updateConfirmInfo?.update_command ?? "hermes update";
    return (
      t.status.updateHermesConfirmMessage ??
      `This will run 'hermes update' (${cmd}) and restart the gateway when it finishes.`
    );
  }, [t.status.updateHermesConfirmMessage, updateConfirmInfo]);

  const items: SystemActionItem[] = [
    {
      action: "restart",
      icon: RotateCw,
      label: t.status.restartGateway,
      runningLabel: t.status.restartingGateway,
      spin: true,
    },
  ];
  if (canUpdateHermes) {
    items.push({
      action: "update",
      icon: Download,
      label: "Upgrade Imperator",
      runningLabel: "Upgrading Imperator",
      spin: false,
    });
  }

  const handleClick = (action: SystemAction) => {
    if (isBusy) return;
    if (action === "restart") {
      setRestartConfirmOpen(true);
      return;
    }
    if (action === "update") {
      setUpdateConfirmInfo(null);
      setUpdateConfirmOpen(true);
      return;
    }
    void runAction(action);
    navigate("/sessions");
    onNavigate();
  };

  const confirmRestart = () => {
    setRestartConfirmOpen(false);
    void runAction("restart");
    navigate("/sessions");
    onNavigate();
  };

  const confirmUpdate = () => {
    setUpdateConfirmOpen(false);
    setUpdateConfirmInfo(null);
    void runAction("update");
    navigate("/sessions");
    onNavigate();
  };

  return (
    <>
    <div
      className={cn(
        "shrink-0 flex flex-col",
        "border-t border-current/10",
        "py-1",
      )}
    >
      <span
        className={cn(
          "px-5 pt-0.5 pb-0.5",
          "font-sans text-display text-xs tracking-[0.12em] text-text-tertiary",
          collapsed && "lg:hidden",
        )}
      >
        {t.app.system}
      </span>

      <div className={cn(collapsed && "lg:hidden")}>
        <SidebarStatusStrip status={status} />
      </div>

      <GatewayDot collapsed={collapsed} status={status} tooltipWarmRef={tooltipWarmRef} />

      <ul className="flex flex-col">
        {items.map((item) => (
          <SystemActionButton
            key={item.action}
            collapsed={collapsed}
            disabled={isBusy && !(pendingAction === item.action || (activeAction === item.action && isRunning))}
            tooltipWarmRef={tooltipWarmRef}
            isPending={pendingAction === item.action}
            isRunning={activeAction === item.action && isRunning && pendingAction !== item.action}
            item={item}
            onClick={() => handleClick(item.action)}
          />
        ))}
      </ul>
    </div>

    <ConfirmDialog
      cancelLabel={t.common.cancel}
      confirmLabel={t.status.restartGateway}
      description={
        t.status.restartGatewayConfirmMessage ??
        "This restarts the Imperator gateway process. Connected channels and active sessions will reconnect afterward."
      }
      loading={pendingAction === "restart"}
      onCancel={() => setRestartConfirmOpen(false)}
      onConfirm={confirmRestart}
      open={restartConfirmOpen}
      title={
        t.status.restartGatewayConfirmTitle ?? `${t.status.restartGateway}?`
      }
    />

    <ConfirmDialog
      cancelLabel={t.common.cancel}
      confirmLabel={t.status.updateHermesConfirmNow ?? "Update now"}
      description={
        updateConfirmChecking ? t.common.loading : updateConfirmDescription
      }
      loading={pendingAction === "update" || updateConfirmChecking}
      onCancel={() => {
        setUpdateConfirmOpen(false);
        setUpdateConfirmInfo(null);
      }}
      onConfirm={confirmUpdate}
      open={updateConfirmOpen}
      title={t.status.updateHermesConfirmTitle ?? `${t.status.updateHermes}?`}
    />
    </>
  );
}

function SystemActionButton({
  collapsed,
  disabled,
  isPending,
  isRunning: isActionRunning,
  item,
  onClick,
  tooltipWarmRef,
}: SystemActionButtonProps) {
  const { icon: Icon, label, runningLabel, spin } = item;
  const [hovered, setHovered] = useState(false);
  const [tooltipAnchor, setTooltipAnchor] = useState<HTMLElement | null>(null);
  const busy = isPending || isActionRunning;
  const displayLabel = isActionRunning ? runningLabel : label;
  const showTooltip = (event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
    setHovered(true);
    setTooltipAnchor(event.currentTarget);
  };
  const hideTooltip = () => {
    setHovered(false);
    setTooltipAnchor(null);
  };

  return (
    <li
      onMouseEnter={collapsed ? showTooltip : undefined}
      onMouseLeave={collapsed ? hideTooltip : undefined}
    >
      <button
        onClick={onClick}
        disabled={disabled}
        aria-busy={busy}
        aria-label={collapsed ? displayLabel : undefined}
        onFocus={collapsed ? showTooltip : undefined}
        onBlur={collapsed ? hideTooltip : undefined}
        type="button"
        className={cn(
          "group/action relative flex w-full items-center gap-3",
          "px-5 py-2.5",
          "font-sans text-display text-xs tracking-[0.1em]",
          "whitespace-nowrap transition-colors cursor-pointer",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground",
          busy
            ? "text-midground"
            : "text-text-secondary hover:text-midground",
          "disabled:text-text-disabled disabled:cursor-not-allowed",
        )}
      >
        {isPending ? (
          <Spinner className="shrink-0 text-[0.875rem]" />
        ) : isActionRunning && spin ? (
          <Spinner className="shrink-0 text-[0.875rem]" />
        ) : (
          <Icon
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              isActionRunning && !spin && "animate-pulse",
            )}
          />
        )}

        <span className={cn(
          "truncate transition-opacity duration-300",
          collapsed ? "lg:opacity-0" : "lg:opacity-100",
        )}>
          {displayLabel}
        </span>

        <span
          aria-hidden
          className="absolute inset-y-0.5 left-1.5 right-1.5 bg-midground opacity-0 pointer-events-none transition-opacity duration-200 group-hover/action:opacity-5"
        />

        {busy && (
          <span
            aria-hidden
            className="absolute left-0 top-0 bottom-0 w-px bg-midground"
          />
        )}
      </button>

      {collapsed && hovered && tooltipAnchor && (
        <SidebarTooltip anchor={tooltipAnchor} label={displayLabel} warmRef={tooltipWarmRef} />
      )}
    </li>
  );
}

function SidebarIconWithTooltip({
  children,
  collapsed,
  label,
  tooltipWarmRef,
}: SidebarIconWithTooltipProps) {
  const [hovered, setHovered] = useState(false);
  const [tooltipAnchor, setTooltipAnchor] = useState<HTMLElement | null>(null);
  const showTooltip = (event: MouseEvent<HTMLDivElement>) => {
    setHovered(true);
    setTooltipAnchor(event.currentTarget);
  };
  const hideTooltip = () => {
    setHovered(false);
    setTooltipAnchor(null);
  };

  return (
    <div
      className={cn(
        "relative w-fit",
        collapsed && "group/icon",
      )}
      onMouseEnter={collapsed ? showTooltip : undefined}
      onMouseLeave={collapsed ? hideTooltip : undefined}
    >
      {children}

      {collapsed && (
        <span
          aria-hidden
          className="absolute inset-y-0 inset-x-[-0.375rem] bg-midground opacity-0 pointer-events-none transition-opacity duration-200 group-hover/icon:opacity-5 hidden lg:block"
        />
      )}

      {collapsed && hovered && tooltipAnchor && (
        <SidebarTooltip anchor={tooltipAnchor} label={label} warmRef={tooltipWarmRef} />
      )}
    </div>
  );
}

function GatewayDot({ collapsed, status, tooltipWarmRef }: GatewayDotProps) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [tooltipAnchor, setTooltipAnchor] = useState<HTMLElement | null>(null);

  const toneToColor: Record<string, string> = {
    "text-success": "bg-success",
    "text-warning": "bg-warning",
    "text-destructive": "bg-destructive",
    "text-muted-foreground": "bg-muted-foreground",
  };

  let color: string;
  let label: string;

  if (!status) {
    color = "bg-midground/20";
    label = t.status.gateway;
  } else {
    const gw = gatewayLine(status, t);
    color = toneToColor[gw.tone] ?? "bg-muted-foreground";
    label = `${t.status.gateway} ${gw.label}`;
  }
  const showTooltip = (event: MouseEvent<HTMLDivElement> | FocusEvent<HTMLDivElement>) => {
    setHovered(true);
    setTooltipAnchor(event.currentTarget);
  };
  const hideTooltip = () => {
    setHovered(false);
    setTooltipAnchor(null);
  };

  return (
    <div
      className={cn(
        "hidden lg:flex py-3 pl-[1.625rem] transition-opacity duration-300",
        collapsed ? "lg:opacity-100" : "lg:opacity-0 lg:h-0 lg:py-0 lg:overflow-hidden",
      )}
      role="status"
      aria-label={label}
      tabIndex={collapsed ? 0 : -1}
      onMouseEnter={collapsed ? showTooltip : undefined}
      onMouseLeave={collapsed ? hideTooltip : undefined}
      onFocus={collapsed ? showTooltip : undefined}
      onBlur={collapsed ? hideTooltip : undefined}
    >
      <span
        aria-hidden
        className={cn("h-1.5 w-1.5 rounded-full", color)}
      />

      {hovered && tooltipAnchor && (
        <SidebarTooltip anchor={tooltipAnchor} label={label} warmRef={tooltipWarmRef} />
      )}
    </div>
  );
}

function SidebarTooltip({ anchor, label, warmRef }: SidebarTooltipProps) {
  const rect = anchor.getBoundingClientRect();
  const sidebar = document.getElementById("app-sidebar");
  const sidebarRight = sidebar?.getBoundingClientRect().right ?? rect.right;
  const [isWarm, setIsWarm] = useState(false);

  useEffect(() => {
    if (!warmRef) {
      setIsWarm(false);
      return;
    }
    const now = Date.now();
    setIsWarm(now - warmRef.current < 300);
    warmRef.current = now;
    return () => {
      if (warmRef) warmRef.current = Date.now();
    };
  }, [warmRef]);

  return createPortal(
    <span
      className={cn(
        "fixed z-[100] pointer-events-none",
        "px-2 py-1",
        "bg-background-base border border-current/20 shadow-lg",
        "font-sans text-display text-xs tracking-[0.1em] text-midground uppercase",
      )}
      style={{
        top: rect.top + rect.height / 2,
        left: sidebarRight + 8,
        transform: "translateY(-50%)",
        opacity: isWarm ? 1 : undefined,
        animation: isWarm ? "none" : "sidebar-tooltip-in 120ms ease-out",
      }}
    >
      {label}
    </span>,
    document.body,
  );
}

type TooltipWarmRef = React.RefObject<number>;

interface GatewayDotProps {
  collapsed: boolean;
  status: StatusResponse | null;
  tooltipWarmRef: TooltipWarmRef;
}

interface NavItem {
  icon: ComponentType<{ className?: string }>;
  label: string;
  labelKey?: string;
  path: string;
}

interface SidebarIconWithTooltipProps {
  children: ReactNode;
  collapsed: boolean;
  label: string;
  tooltipWarmRef: TooltipWarmRef;
}

interface GroupedCoreNavProps {
  closeMobile: () => void;
  collapsed: boolean;
  items: NavItem[];
  t: Translations;
  tooltipWarmRef: TooltipWarmRef;
}

interface SidebarNavLinkProps {
  closeMobile: () => void;
  collapsed: boolean;
  item: NavItem;
  t: Translations;
  tooltipWarmRef: TooltipWarmRef;
}

interface SidebarSystemActionsProps {
  collapsed: boolean;
  onNavigate: () => void;
  status: StatusResponse | null;
  tooltipWarmRef: TooltipWarmRef;
}

interface SidebarTooltipProps {
  anchor: HTMLElement;
  label: string;
  warmRef?: TooltipWarmRef;
}

interface SystemActionButtonProps {
  collapsed: boolean;
  disabled: boolean;
  isPending: boolean;
  isRunning: boolean;
  item: SystemActionItem;
  onClick: () => void;
  tooltipWarmRef: TooltipWarmRef;
}

interface SystemActionItem {
  action: SystemAction;
  icon: ComponentType<{ className?: string }>;
  label: string;
  runningLabel: string;
  spin: boolean;
}
