import type { DashboardTheme, ThemeTypography, ThemeLayout } from "./types";

/**
 * The Imperator dashboard scheme.
 *
 * The dashboard intentionally ships a single color scheme — theme switching
 * was removed so the whole product carries one brand identity. The palette
 * is derived from the name "Imperator": Imperator gold (aurum) chrome on a
 * deep obsidian-violet canvas — the Tyrian purple + gold of a Roman
 * imperator, tuned for WCAG-comfortable contrast on dark UI.
 *
 *   canvas   #0f0b1e — "Imperator night" (near-black violet)
 *   accent   #e8c87a — "aurum" (Imperator gold; primary text + chrome)
 *
 * Contrast: #e8c87a on #0f0b1e ≈ 11:1; the DS derives text-secondary /
 * text-tertiary from midground alpha, both staying above 4.5:1.
 *
 * The server-rendered /login page (hermes_cli/dashboard_auth/login_page.py)
 * uses the same values — keep the two in sync so the login → dashboard
 * transition reads as one product.
 */

/** Default system stack — neutral, safe fallback for every platform. */
const SYSTEM_SANS =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const SYSTEM_MONO =
  'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';

const IMPERATOR_TYPOGRAPHY: ThemeTypography = {
  fontSans: SYSTEM_SANS,
  fontMono: SYSTEM_MONO,
  baseSize: "15px",
  lineHeight: "1.55",
  letterSpacing: "0",
};

const IMPERATOR_LAYOUT: ThemeLayout = {
  radius: "0.5rem",
  density: "comfortable",
};

export const imperatorTheme: DashboardTheme = {
  name: "imperator",
  label: "Imperator",
  description: "Imperator gold on deep violet — the Imperator scheme",
  palette: {
    background: { hex: "#0f0b1e", alpha: 1 },
    midground: { hex: "#e8c87a", alpha: 1 },
    foreground: { hex: "#ffffff", alpha: 0 },
    warmGlow: "rgba(232, 200, 122, 0.32)",
    noiseOpacity: 1,
  },
  typography: IMPERATOR_TYPOGRAPHY,
  layout: IMPERATOR_LAYOUT,
  colorOverrides: {
    destructive: "#f0523f",
    success: "#3dd68c",
    warning: "#f5a623",
  },
  seriesColors: {
    inputTokenAccent: "#e8c87a",
    outputTokenAccent: "#a78bfa",
  },
  terminalBackground: "#0a0716",
  terminalForeground: "#f0e2c0",
};

/** The active (and only) scheme. Kept under the historical export names so
 *  existing imports keep working. */
export const defaultTheme: DashboardTheme = imperatorTheme;

export const BUILTIN_THEMES: Record<string, DashboardTheme> = {
  imperator: imperatorTheme,
};
