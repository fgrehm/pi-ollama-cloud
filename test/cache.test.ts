import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CACHE_TTL_MS, createCache, FAIL_TTL_MS, isFresh, searchCacheKey } from "../cache.ts";

function freshCache() {
  const dir = mkdtempSync(join(tmpdir(), "ollama-cache-"));
  return { mod: createCache({ path: join(dir, "cache.json") }), dir };
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

    const mod2 = createCache({ path: join(dir, "cache.json") });
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
    c.searches.stale = { ts: Date.now() - CACHE_TTL_MS - 1000, q: "q", results: [] };
    c.searches.fresh = { ts: Date.now(), q: "q", results: [] };
    c.pages["https://stale"] = { ts: Date.now() - FAIL_TTL_MS - 1000, error: "HTTP 404" };
    mod.saveCache();

    const mod2 = createCache({ path: join(dir, "cache.json") });
    const c2 = mod2.loadCache();
    expect(c2.searches.stale).toBeUndefined();
    expect(c2.searches.fresh).toBeDefined();
    expect(c2.pages["https://stale"]).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("isFresh", () => {
  it("accepts a fresh success entry", async () => {
    await freshCache();
    expect(isFresh({ ts: Date.now() })).toBe(true);
  });

  it("accepts a fresh failure entry", async () => {
    await freshCache();
    expect(isFresh({ ts: Date.now(), error: "boom" })).toBe(true);
  });

  it("rejects an expired success entry after the success TTL", async () => {
    await freshCache();
    expect(isFresh({ ts: Date.now() - CACHE_TTL_MS - 1000 })).toBe(false);
  });

  it("rejects an expired failure entry after the shorter failure TTL", async () => {
    await freshCache();
    expect(isFresh({ ts: Date.now() - FAIL_TTL_MS - 1000, error: "boom" })).toBe(false);
  });

  it("rejects a missing entry", async () => {
    await freshCache();
    expect(isFresh(undefined)).toBe(false);
  });
});

describe("searchCacheKey", () => {
  it("is stable for the same query and max_results", async () => {
    await freshCache();
    expect(searchCacheKey("q", 5)).toBe(searchCacheKey("q", 5));
  });

  it("differs when max_results differs", async () => {
    await freshCache();
    expect(searchCacheKey("q", 5)).not.toBe(searchCacheKey("q", 10));
  });
});
