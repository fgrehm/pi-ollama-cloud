import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// cache.ts reads env at module load; re-import per test with an isolated path.
async function freshCache() {
  const dir = mkdtempSync(join(tmpdir(), "ollama-cache-"));
  vi.stubEnv("PI_OLLAMA_SEARCH_CACHE_PATH", join(dir, "cache.json"));
  vi.resetModules();
  const mod = await import("../cache.ts");
  return { mod, dir };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("loadCache/saveCache", () => {
  it("persists entries to disk and reloads them in a fresh module instance", async () => {
    const { mod, dir } = await freshCache();
    const c = mod.loadCache();
    const now = Date.now();
    c.searches.k = {
      ts: now,
      q: "q",
      results: [{ title: "t", url: "u", content: "c" }],
    };
    c.pages["https://dead"] = { ts: now, error: "HTTP 404" };
    mod.saveCache();

    vi.resetModules();
    const mod2 = await import("../cache.ts");
    const c2 = mod2.loadCache();
    expect(c2.searches.k.results[0].title).toBe("t");
    expect(c2.pages["https://dead"].error).toBe("HTTP 404");
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts fresh when the cache file is missing or corrupt", async () => {
    const { mod, dir } = await freshCache();
    writeFileSync(join(dir, "cache.json"), "not json");
    const c = mod.loadCache();
    expect(c.searches).toEqual({});
    expect(c.pages).toEqual({});
    rmSync(dir, { recursive: true, force: true });
  });

  it("prunes expired entries on save", async () => {
    const { mod, dir } = await freshCache();
    const c = mod.loadCache();
    c.searches.stale = { ts: Date.now() - mod.CACHE_TTL_MS - 1000, q: "q", results: [] };
    c.searches.fresh = { ts: Date.now(), q: "q", results: [] };
    c.pages["https://stale"] = { ts: Date.now() - mod.FAIL_TTL_MS - 1000, error: "HTTP 404" };
    mod.saveCache();

    vi.resetModules();
    const mod2 = await import("../cache.ts");
    const c2 = mod2.loadCache();
    expect(c2.searches.stale).toBeUndefined();
    expect(c2.searches.fresh).toBeDefined();
    expect(c2.pages["https://stale"]).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("isFresh", () => {
  it("accepts a fresh success entry", async () => {
    const { mod } = await freshCache();
    expect(mod.isFresh({ ts: Date.now() })).toBe(true);
  });

  it("accepts a fresh failure entry", async () => {
    const { mod } = await freshCache();
    expect(mod.isFresh({ ts: Date.now(), error: "boom" })).toBe(true);
  });

  it("rejects an expired success entry after the success TTL", async () => {
    const { mod } = await freshCache();
    expect(mod.isFresh({ ts: Date.now() - mod.CACHE_TTL_MS - 1000 })).toBe(false);
  });

  it("rejects an expired failure entry after the shorter failure TTL", async () => {
    const { mod } = await freshCache();
    expect(mod.isFresh({ ts: Date.now() - mod.FAIL_TTL_MS - 1000, error: "boom" })).toBe(false);
  });

  it("rejects a missing entry", async () => {
    const { mod } = await freshCache();
    expect(mod.isFresh(undefined)).toBe(false);
  });
});

describe("searchCacheKey", () => {
  it("is stable for the same query and max_results", async () => {
    const { mod } = await freshCache();
    expect(mod.searchCacheKey("q", 5)).toBe(mod.searchCacheKey("q", 5));
  });

  it("differs when max_results differs", async () => {
    const { mod } = await freshCache();
    expect(mod.searchCacheKey("q", 5)).not.toBe(mod.searchCacheKey("q", 10));
  });
});
