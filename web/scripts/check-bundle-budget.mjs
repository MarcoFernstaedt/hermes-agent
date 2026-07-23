#!/usr/bin/env node
/**
 * Bundle budget checker.
 *
 * Makes initial-load size a tracked, enforced metric so adding modules can't
 * silently bloat first paint. Reads the built dashboard, measures the gzip
 * size of the INITIAL JS (the entry chunk plus everything index.html
 * modulepreloads — i.e. what a cold visitor downloads before the app runs) and
 * of each lazily-loaded route chunk, and fails if any ceiling is exceeded.
 *
 * Two thresholds per category:
 *   - ceiling: a hard fail (catches regressions).
 *   - target:  an aspiration; over-target is reported, not failed.
 *
 * Run: `npm run budget` (after `vite build`). Exits non-zero on a ceiling
 * breach so CI can gate on it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "..", "hermes_cli", "web_dist");
const ASSETS = join(DIST, "assets");

// Budgets in gzip KB. Ceilings catch regression at today's reality; targets
// are the aspiration. The initial JS is dominated by react-dom (~124 KB, a
// fixed framework floor) and the persistent ChatPage host (xterm + markdown,
// eagerly loaded so chat state survives navigation). Reaching the initial-JS
// target needs a lazy-but-persistent chat refactor — tracked as follow-up.
const BUDGETS = {
  initialJs: { target: 250, ceiling: 500 },
  initialCss: { target: 24, ceiling: 40 },
  routeChunk: { target: 150, ceiling: 200 },
};

function gzipKb(path) {
  return gzipSync(readFileSync(path)).length / 1024;
}

function initialAssets() {
  const html = readFileSync(join(DIST, "index.html"), "utf8");
  const js = new Set();
  const css = new Set();
  for (const m of html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)) js.add(m[1]);
  for (const m of html.matchAll(/href="\/assets\/([^"]+\.css)"/g)) css.add(m[1]);
  return { js: [...js], css: [...css] };
}

function fmt(kb) {
  return `${kb.toFixed(1)} KB`;
}

function main() {
  let allFiles;
  try {
    allFiles = readdirSync(ASSETS);
  } catch {
    console.error(`No build found at ${ASSETS}. Run \`vite build\` first.`);
    process.exit(2);
  }

  const initial = initialAssets();
  const initialJs = initial.js.reduce((s, f) => s + gzipKb(join(ASSETS, f)), 0);
  const initialCss = initial.css.reduce((s, f) => s + gzipKb(join(ASSETS, f)), 0);

  const initialSet = new Set([...initial.js, ...initial.css]);
  const lazy = allFiles
    .filter((f) => f.endsWith(".js") && !initialSet.has(f))
    .map((f) => ({ f, kb: gzipKb(join(ASSETS, f)) }))
    .sort((a, b) => b.kb - a.kb);

  const failures = [];
  const check = (name, kb, budget) => {
    const status =
      kb > budget.ceiling ? "FAIL" : kb > budget.target ? "over-target" : "ok";
    if (status === "FAIL") failures.push(name);
    return status;
  };

  console.log("Initial load (cold first paint):");
  console.log(
    `  JS  ${fmt(initialJs)}  [target ${BUDGETS.initialJs.target}, ceiling ` +
      `${BUDGETS.initialJs.ceiling}]  ${check("initialJs", initialJs, BUDGETS.initialJs)}`,
  );
  console.log(
    `  CSS ${fmt(initialCss)}  [target ${BUDGETS.initialCss.target}, ceiling ` +
      `${BUDGETS.initialCss.ceiling}]  ${check("initialCss", initialCss, BUDGETS.initialCss)}`,
  );
  console.log(`  (${initial.js.length} initial JS chunks incl. react-dom vendor)`);

  console.log("\nLargest lazy route chunks:");
  for (const { f, kb } of lazy.slice(0, 8)) {
    console.log(
      `  ${fmt(kb).padStart(9)}  ${f}  ${check(f, kb, BUDGETS.routeChunk)}`,
    );
  }

  if (failures.length) {
    console.error(`\nBudget FAIL: ${failures.join(", ")} exceeded ceiling.`);
    process.exit(1);
  }
  console.log("\nAll bundle budgets within ceiling.");
}

main();
