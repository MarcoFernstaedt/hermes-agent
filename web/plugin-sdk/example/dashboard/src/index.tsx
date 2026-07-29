/* eslint-disable react-refresh/only-export-components -- plugin entry: registers a component, does not export one. */
/**
 * Canonical dashboard-plugin template.
 *
 * Authored in normal TSX. Everything comes from the host via the virtual
 * `imperator` module — React, hooks, the design system, and the API client —
 * so the built bundle stays tiny and always matches the host's versions.
 *
 * Build:  cd web && npm run build:plugin -- plugin-sdk/example
 * Ship:   copy this folder to plugins/<name>/ and rebuild; the host discovers
 *         plugins/<name>/dashboard/manifest.json and mounts the tab.
 */
import { hooks, components, utils, register } from "imperator";

const { useState } = hooks;
const { Card, CardContent, Button } = components;
const { cn } = utils;

function ExamplePanel() {
  const [count, setCount] = useState(0);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 p-6">
      <h1 className="font-sans text-lg font-semibold">Example plugin</h1>
      <Card>
        <CardContent className={cn("flex items-center justify-between gap-4 py-4")}>
          <p className="text-sm text-text-secondary">
            This whole tab is a removable plugin built from TSX. Clicked{" "}
            <span className="tabular-nums font-medium">{count}</span> times.
          </p>
          <Button onClick={() => setCount((c) => c + 1)}>Click me</Button>
        </CardContent>
      </Card>
    </div>
  );
}

register("example-panel", ExamplePanel);
