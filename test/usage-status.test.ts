import { describe, expect, it } from "vitest";
import { resolveUsageStatusToggle } from "../index.ts";

describe("resolveUsageStatusToggle", () => {
  it("enables to sidebar on 'on', 'enable', and 'sidebar'", () => {
    expect(resolveUsageStatusToggle("on", "off")).toEqual({ mode: "sidebar" });
    expect(resolveUsageStatusToggle("enable", "off")).toEqual({ mode: "sidebar" });
    expect(resolveUsageStatusToggle("sidebar", "statusbar")).toEqual({ mode: "sidebar" });
  });

  it("selects statusbar explicitly", () => {
    expect(resolveUsageStatusToggle("statusbar", "sidebar")).toEqual({ mode: "statusbar" });
  });

  it("disables on 'off' and 'disable'", () => {
    expect(resolveUsageStatusToggle("off", "sidebar")).toEqual({ mode: "off" });
    expect(resolveUsageStatusToggle("disable", "statusbar")).toEqual({ mode: "off" });
  });

  it("toggles between sidebar and off from every current mode", () => {
    expect(resolveUsageStatusToggle("", "sidebar")).toEqual({ mode: "off" });
    expect(resolveUsageStatusToggle("", "statusbar")).toEqual({ mode: "off" });
    expect(resolveUsageStatusToggle("", "off")).toEqual({ mode: "sidebar" });
  });

  it("is case-insensitive and trims surrounding whitespace", () => {
    expect(resolveUsageStatusToggle("  ON  ", "off")).toEqual({ mode: "sidebar" });
    expect(resolveUsageStatusToggle("SIDEBAR", "off")).toEqual({ mode: "sidebar" });
  });

  it("returns an error for unknown arguments, keeping the current state", () => {
    const result = resolveUsageStatusToggle("bogus", "statusbar");
    expect(result.mode).toBe("statusbar");
    expect(result.error).toContain("Unknown argument");
    expect(result.error).toContain("sidebar");
  });
});
