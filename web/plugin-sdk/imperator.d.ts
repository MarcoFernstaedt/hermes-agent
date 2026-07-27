/**
 * Type surface for the virtual `imperator` module that dashboard plugins import
 * from. At runtime every export is backed by the host globals
 * (`window.__HERMES_PLUGIN_SDK__` / `window.__HERMES_PLUGINS__`); the build
 * pipeline (scripts/build-dashboard-plugin.mjs) resolves the import to them, so
 * React, the design system and the API client are never re-bundled.
 *
 * Keep in sync with web/src/plugins/registry.ts::exposePluginSDK.
 */
declare module "imperator" {
  import type * as ReactNS from "react";
  import type { ComponentType } from "react";

  export const React: typeof ReactNS;
  export const hooks: {
    useState: typeof ReactNS.useState;
    useEffect: typeof ReactNS.useEffect;
    useCallback: typeof ReactNS.useCallback;
    useMemo: typeof ReactNS.useMemo;
    useRef: typeof ReactNS.useRef;
    useContext: typeof ReactNS.useContext;
    createContext: typeof ReactNS.createContext;
  };

  /** Typed Imperator API client (loose here to keep the contract stable). */
  export const api: Record<string, (...args: unknown[]) => Promise<unknown>>;
  export const fetchJSON: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  export const authedFetch: (path: string, init?: RequestInit) => Promise<Response>;
  export const buildWsUrl: (path: string) => Promise<string>;
  export const buildWsAuthParam: () => Promise<[string, string]>;

  /** Design-system components (Nous DS / shadcn primitives). */
  export const components: Record<string, ComponentType<Record<string, unknown>>>;
  export const utils: {
    cn: (...classes: unknown[]) => string;
    timeAgo: (date: Date | number) => string;
    isoTimeAgo: (iso: string) => string;
  };
  export const useI18n: () => { t: Record<string, unknown> };
  export const sdkVersion: string;

  /** Register the plugin's tab component. Name must match the manifest. */
  export function register(name: string, component: ComponentType): void;
  /** Register a component into a named host slot. */
  export function registerSlot(slot: string, component: ComponentType): void;
}
