import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, type OllamaCloudConfig, resolveUsageDisplay } from "../config.ts";

describe("resolveUsageDisplay", () => {
  it("defaults to sidebar when neither key is set", () => {
    expect(resolveUsageDisplay({})).toBe("sidebar");
    expect(resolveUsageDisplay({ webTools: true })).toBe("sidebar");
  });

  it("maps the legacy usageStatus boolean", () => {
    expect(resolveUsageDisplay({ usageStatus: true })).toBe("statusbar");
    expect(resolveUsageDisplay({ usageStatus: false })).toBe("off");
  });

  it("prefers an explicit usageDisplay over the legacy boolean", () => {
    expect(resolveUsageDisplay({ usageStatus: true, usageDisplay: "off" })).toBe("off");
    expect(resolveUsageDisplay({ usageStatus: false, usageDisplay: "sidebar" })).toBe("sidebar");
    expect(resolveUsageDisplay({ usageStatus: true, usageDisplay: "statusbar" })).toBe("statusbar");
  });

  it("passes each explicit mode through", () => {
    for (const mode of ["sidebar", "statusbar", "off"] as const) {
      expect(resolveUsageDisplay({ usageDisplay: mode })).toBe(mode);
    }
  });
});

describe("config schema", () => {
  it("drops invalid usageDisplay values instead of crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ollama-config-"));
    try {
      const projectDir = join(dir, ".pi");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(projectDir, "ollama-cloud.json"),
        JSON.stringify({ usageDisplay: "bogus", usageStatus: true }),
      );
      const config: OllamaCloudConfig = loadConfig(dir);
      expect(config.usageDisplay).toBeUndefined();
      expect(config.usageStatus).toBe(true);
      expect(resolveUsageDisplay(config)).toBe("statusbar");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
