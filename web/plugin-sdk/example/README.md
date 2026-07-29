# Example dashboard plugin

The canonical template for a **rich, removable dashboard module** authored in
TSX. Copy this folder to `plugins/<your-name>/` and rebuild to start a real
plugin. See `docs/dashboard-modules.md` for when to use this vs. a capability
manifest.

```
dashboard/
  manifest.json     # name, label, icon, tab {path, position}, entry
  src/index.tsx     # your component; import from "imperator"; register(name, C)
  dist/index.js     # built artifact — commit it; the host serves this
```

Build (from the repo's `web/` directory):

```bash
npm run build:plugin -- plugin-sdk/example           # one-shot
npm run build:plugin -- plugin-sdk/example --watch   # while editing
```

Everything (React, hooks, the design system, the API client) comes from the
host at runtime via the `imperator` virtual module, so the bundle stays tiny and
always matches the host's versions. Do not import `react` or `@nous-research/ui`
directly — import from `imperator`.

This example is not mounted in the app (it lives under `web/plugin-sdk/`, not
`plugins/`); its build is asserted by `web/src/plugins/build-pipeline.test.ts`.
