import { describe, expect, it } from "vitest";
import { resolveUsageStatusToggle } from "../index.ts";

describe("resolveUsageStatusToggle", () => {
  it("enables on 'on' and 'enable'", () => {
    expect(resolveUsageStatusToggle("on", false)).toEqual({ enabled: true });
    expect(resolveUsageStatusToggle("enable", false)).toEqual({ enabled: true });
  });

  it("disables on 'off' and 'disable'", () => {
    expect(resolveUsageStatusToggle("off", true)).toEqual({ enabled: false });
    expect(resolveUsageStatusToggle("disable", true)).toEqual({ enabled: false });
  });

  it("toggles with no argument", () => {
    expect(resolveUsageStatusToggle("", true)).toEqual({ enabled: false });
    expect(resolveUsageStatusToggle("", false)).toEqual({ enabled: true });
  });

  it("is case-insensitive and trims surrounding whitespace", () => {
    expect(resolveUsageStatusToggle("  ON  ", false)).toEqual({ enabled: true });
  });

  it("returns an error for unknown arguments, keeping the current state", () => {
    const result = resolveUsageStatusToggle("bogus", true);
    expect(result.enabled).toBe(true);
    expect(result.error).toContain("Unknown argument");
  });
});
