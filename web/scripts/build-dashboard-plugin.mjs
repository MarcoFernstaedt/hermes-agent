#!/usr/bin/env node
/**
 * Build a dashboard plugin from TSX source into the IIFE bundle the host loads.
 *
 * This is the in-repo build pipeline that lets a rich module be authored as
 * normal TypeScript + JSX and shipped as a self-contained, removable plugin —
 * instead of a hand-written `React.createElement` blob. Authors write:
 *
 *     import { React, hooks, components, api, register } from "imperator";
 *     function Board() { const { useState } = hooks; return <components.Card/>; }
 *     register("my-plugin", Board);
 *
 * and this script bundles it, mapping every `imperator` import to the host's
 * `window.__HERMES_PLUGIN_SDK__` / `window.__HERMES_PLUGINS__` globals so React,
 * the design system, and the API client are never re-bundled. Output goes to
 * `<plugin>/dashboard/dist/index.js` (+ style.css when a CSS entry exists).
 *
 * Usage:  node scripts/build-dashboard-plugin.mjs <path-to-plugin-dir> [--watch]
 */
import { build, context } from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const arg = process.argv[2];
const watch = process.argv.includes("--watch");
if (!arg) {
  console.error("usage: build-dashboard-plugin.mjs <plugin-dir> [--watch]");
  process.exit(2);
}

const pluginRoot = resolve(arg);
// Accept either the plugin root (…/my-plugin) or its dashboard dir directly.
const dashboardDir = existsSync(join(pluginRoot, "manifest.json"))
  ? pluginRoot
  : join(pluginRoot, "dashboard");
const manifestPath = join(dashboardDir, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`no manifest.json under ${dashboardDir}`);
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const entrySrc = ["src/index.tsx", "src/index.ts", "src/index.jsx"]
  .map((p) => join(dashboardDir, p))
  .find(existsSync);
if (!entrySrc) {
  console.error(`no src/index.tsx under ${dashboardDir}`);
  process.exit(2);
}

// The virtual "imperator" module: every named export is pulled from the host
// globals at runtime, so nothing here is bundled into the plugin. Keep in sync
// with web/src/plugins/registry.ts::exposePluginSDK.
const IMPERATOR_SHIM = `
const __SDK = (typeof window !== "undefined" && window.__HERMES_PLUGIN_SDK__) || {};
const __P = (typeof window !== "undefined" && window.__HERMES_PLUGINS__) || {};
export const React = __SDK.React;
export const hooks = __SDK.hooks || {};
export const api = __SDK.api;
export const fetchJSON = __SDK.fetchJSON;
export const authedFetch = __SDK.authedFetch;
export const buildWsUrl = __SDK.buildWsUrl;
export const buildWsAuthParam = __SDK.buildWsAuthParam;
export const components = __SDK.components || {};
export const utils = __SDK.utils || {};
export const useI18n = __SDK.useI18n;
export const sdkVersion = __SDK.sdkVersion;
export const register = (name, component) => __P.register && __P.register(name, component);
export const registerSlot = (...a) => __P.registerSlot && __P.registerSlot(...a);
`;

/** Resolve `imperator` to the host-backed shim, and auto-inject React for JSX. */
const imperatorPlugin = {
  name: "imperator-sdk",
  setup(b) {
    b.onResolve({ filter: /^imperator$/ }, () => ({
      path: "imperator",
      namespace: "imperator-sdk",
    }));
    b.onLoad({ filter: /.*/, namespace: "imperator-sdk" }, () => ({
      contents: IMPERATOR_SHIM,
      loader: "js",
    }));
  },
};

// Inject `React` into every module so classic JSX (`React.createElement`) works
// without each file importing it. The inject file re-exports React from the shim.
const reactInject = join(dirname(new URL(import.meta.url).pathname), "plugin-react-inject.js");

const options = {
  entryPoints: [entrySrc],
  outfile: join(dashboardDir, "dist", "index.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  jsx: "transform",
  jsxFactory: "React.createElement",
  jsxFragment: "React.Fragment",
  inject: [reactInject],
  plugins: [imperatorPlugin],
  loader: { ".css": "css" },
  minify: !watch,
  sourcemap: false,
  banner: {
    js: `/* ${manifest.name} v${manifest.version || "0.0.0"} — built by build-dashboard-plugin.mjs. Do not edit dist/. */`,
  },
  logLevel: "info",
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log(`[plugin] watching ${manifest.name}…`);
} else {
  await build(options);
  console.log(`[plugin] built ${manifest.name} → dashboard/dist/index.js`);
}
