import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n", () => ({
  useI18n: () => ({ t: { app: { footer: { org: "Imperator Systems" } } } }),
}));

import { SidebarFooter } from "./SidebarFooter";

describe("sidebar organization branding", () => {
  it("links Imperator Systems without changing technical identifiers", () => {
    const html = renderToStaticMarkup(<SidebarFooter status={null} />);

    expect(html).toContain('href="https://imperatorsystems.tech"');
    expect(html).toContain("Imperator Systems");
    expect(html).not.toContain("https://nousresearch.com");
  });
});
