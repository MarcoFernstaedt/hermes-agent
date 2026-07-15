import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CommandPalette,
  rankPaletteItems,
  type CommandPaletteItem,
} from "./CommandPalette";

const item = (
  id: string,
  label: string,
  keywords?: string,
): CommandPaletteItem => ({ id, label, keywords, run: () => undefined });

const NAV: CommandPaletteItem[] = [
  item("/sessions", "Sessions", "Operate"),
  item("/cron", "Cron", "Automate"),
  item("/channels", "Channels", "Connect"),
  item("/config", "Config", "Settings"),
  item("/chat", "Chat"),
];

describe("rankPaletteItems", () => {
  it("returns everything in original order for an empty query", () => {
    expect(rankPaletteItems(NAV, "").map((i) => i.id)).toEqual(
      NAV.map((i) => i.id),
    );
  });

  it("fuzzy matches abbreviations", () => {
    const ids = rankPaletteItems(NAV, "crn").map((i) => i.id);
    expect(ids).toEqual(["/cron"]);
  });

  it("ranks a prefix hit above scattered hits", () => {
    const ids = rankPaletteItems(NAV, "ch").map((i) => i.id);
    expect(ids[0]).toBe("/chat");
    expect(ids).toContain("/channels");
  });

  it("matches on section keywords too", () => {
    const ids = rankPaletteItems(NAV, "automate").map((i) => i.id);
    expect(ids).toEqual(["/cron"]);
  });

  it("drops non-matches", () => {
    expect(rankPaletteItems(NAV, "zzzz")).toEqual([]);
  });
});

describe("CommandPalette", () => {
  it("renders nothing when closed", () => {
    const html = renderToStaticMarkup(
      <CommandPalette open={false} onClose={() => undefined} items={NAV} />,
    );
    expect(html).toBe("");
  });
});
