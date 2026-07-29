import { createContext, useContext, useEffect, type ReactNode } from "react";
import { imperatorTheme } from "./presets";
import type {
  DashboardTheme,
  ThemeColorOverrides,
  ThemeDensity,
  ThemeLayer,
  ThemeLayout,
  ThemePalette,
  ThemeSeriesColors,
  ThemeTypography,
} from "./types";

/**
 * Static theme application — the dashboard ships exactly one scheme
 * (Imperator; see `presets.ts`). Theme switching, user theme YAMLs, and
 * the font override were removed with it: one brand, one look, no
 * client/server theme state to reconcile.
 *
 * `index.css` carries the same values as static `:root` defaults so the
 * first paint (before React mounts) is already on-brand; this provider
 * re-asserts them and keeps components that read `useTheme()` (terminal
 * colors in ChatPage / HermesConsoleModal) working.
 */

// ---------------------------------------------------------------------------
// CSS variable builders
// ---------------------------------------------------------------------------

/** Turn a ThemeLayer into the two CSS expressions the DS consumes:
 *  `--<name>` (color-mix'd with alpha) and `--<name>-base` (opaque hex). */
function layerVars(
  name: "background" | "midground" | "foreground",
  layer: ThemeLayer,
): Record<string, string> {
  const pct = Math.round(layer.alpha * 100);
  return {
    [`--${name}`]: `color-mix(in srgb, ${layer.hex} ${pct}%, transparent)`,
    [`--${name}-base`]: layer.hex,
    [`--${name}-alpha`]: String(layer.alpha),
  };
}

function paletteVars(palette: ThemePalette): Record<string, string> {
  return {
    ...layerVars("background", palette.background),
    ...layerVars("midground", palette.midground),
    ...layerVars("foreground", palette.foreground),
  };
}

const DENSITY_MULTIPLIERS: Record<ThemeDensity, string> = {
  compact: "0.85",
  comfortable: "1",
  spacious: "1.2",
};

function typographyVars(typo: ThemeTypography): Record<string, string> {
  return {
    "--theme-font-sans": typo.fontSans,
    "--theme-font-mono": typo.fontMono,
    "--theme-font-display": typo.fontDisplay ?? typo.fontSans,
    "--theme-base-size": typo.baseSize,
    "--theme-line-height": typo.lineHeight,
    "--theme-letter-spacing": typo.letterSpacing,
  };
}

function layoutVars(layout: ThemeLayout): Record<string, string> {
  return {
    "--radius": layout.radius,
    "--theme-radius": layout.radius,
    "--theme-spacing-mul": DENSITY_MULTIPLIERS[layout.density] ?? "1",
    "--theme-density": layout.density,
  };
}

/** Map a color-overrides key (camelCase) to its `--color-*` CSS var. */
const OVERRIDE_KEY_TO_VAR: Record<keyof ThemeColorOverrides, string> = {
  card: "--color-card",
  cardForeground: "--color-card-foreground",
  popover: "--color-popover",
  popoverForeground: "--color-popover-foreground",
  primary: "--color-primary",
  primaryForeground: "--color-primary-foreground",
  secondary: "--color-secondary",
  secondaryForeground: "--color-secondary-foreground",
  muted: "--color-muted",
  mutedForeground: "--color-muted-foreground",
  accent: "--color-accent",
  accentForeground: "--color-accent-foreground",
  destructive: "--color-destructive",
  destructiveForeground: "--color-destructive-foreground",
  success: "--color-success",
  warning: "--color-warning",
  border: "--color-border",
  input: "--color-input",
  ring: "--color-ring",
};

function overrideVars(
  overrides: ThemeColorOverrides | undefined,
): Record<string, string> {
  if (!overrides) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (!value) continue;
    const cssVar = OVERRIDE_KEY_TO_VAR[key as keyof ThemeColorOverrides];
    if (cssVar) out[cssVar] = value;
  }
  return out;
}

const SERIES_KEY_TO_VAR: Record<keyof ThemeSeriesColors, string> = {
  inputTokenAccent: "--series-input-token",
  outputTokenAccent: "--series-output-token",
};

function seriesColorVars(
  series: ThemeSeriesColors | undefined,
): Record<string, string> {
  if (!series) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(series)) {
    if (!value) continue;
    const cssVar = SERIES_KEY_TO_VAR[key as keyof ThemeSeriesColors];
    if (cssVar) out[cssVar] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Apply the scheme to :root
// ---------------------------------------------------------------------------

function applyTheme(theme: DashboardTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  const vars = {
    ...paletteVars(theme.palette),
    ...typographyVars(theme.typography),
    ...layoutVars(theme.layout),
    ...overrideVars(theme.colorOverrides),
    ...seriesColorVars(theme.seriesColors),
  };
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
  }

  root.dataset.layoutVariant = theme.layoutVariant ?? "standard";

  // Terminal colors — read by ChatPage via useTheme(); also available as CSS vars.
  root.style.setProperty(
    "--theme-terminal-background",
    theme.terminalBackground ?? "#000000",
  );
  root.style.setProperty(
    "--theme-terminal-foreground",
    theme.terminalForeground ?? "#f0e6d2",
  );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    applyTheme(imperatorTheme);
  }, []);

  return (
    <ThemeContext.Provider value={THEME_CONTEXT_VALUE}>
      {children}
    </ThemeContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- context hook paired with its provider in this file.
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

const THEME_CONTEXT_VALUE: ThemeContextValue = { theme: imperatorTheme };

const ThemeContext = createContext<ThemeContextValue>(THEME_CONTEXT_VALUE);

interface ThemeContextValue {
  /** The active (only) dashboard scheme. */
  theme: DashboardTheme;
}
