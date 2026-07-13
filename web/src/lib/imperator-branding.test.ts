import { describe, expect, it } from "vitest";

import { imperatorThemeLabel } from "./imperator-branding";

describe("Imperator theme branding", () => {
  it("removes Hermes from built-in theme labels without changing other themes", () => {
    expect(imperatorThemeLabel("Hermes Teal")).toBe("Imperator Teal");
    expect(imperatorThemeLabel("Cyberpunk")).toBe("Cyberpunk");
  });
});
