import { describe, expect, it } from "vitest";

import { imperatorThemeLabel } from "./imperator-branding";

describe("Imperator theme branding", () => {
  it("removes Imperator from built-in theme labels without changing other themes", () => {
    expect(imperatorThemeLabel("Imperator Teal")).toBe("Imperator Teal");
    expect(imperatorThemeLabel("Cyberpunk")).toBe("Cyberpunk");
  });
});
