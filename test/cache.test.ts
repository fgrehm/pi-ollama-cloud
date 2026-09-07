import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CACHE_TTL_MS, createCache, FAIL_TTL_MS, isFresh, searchCacheKey } from "../cache.ts";

function freshCache(maxEntries?: number) {
  const dir = mkdtempSync(join(tmpdir(), "ollama-cache-"));
  return {
    mod: createCache({ path: join(dir, "cache.json"), ...(maxEntries !== undefined ? { maxEntries } : {}) }),
    dir,
  };
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

  it("drops partially corrupted entries while keeping valid ones", async () => {
    const { mod, dir } = await freshCache();
    const poisoned = {
      searches: {
        bad: { ts: Date.now(), q: "q", results: "not an array" },
        ugly: { ts: Date.now(), q: "q", results: [{ title: "t", url: "u" }] },
        good: { ts: Date.now(), q: "q", results: [{ title: "t", url: "u", content: "c" }] },
      },
      pages: {
        "https://bad": { ts: Date.now(), content: 42 },
        "https://good": { ts: Date.now(), title: "ok", content: "c", links: null },
      },
    };
    writeFileSync(join(dir, "cache.json"), JSON.stringify(poisoned));
    const c = mod.loadCache();
    expect(Object.keys(c.searches)).toEqual(["good"]);
    expect(Object.keys(c.pages)).toEqual(["https://good"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("treats a future timestamp as stale", async () => {
    const { mod, dir } = await freshCache();
    const c = mod.loadCache();
    c.pages["https://future"] = { ts: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000, title: "t", content: "c" };
    expect(mod.isFresh(c.pages["https://future"])).toBe(false);
    mod.saveCache();
    expect(mod.loadCache().pages["https://future"]).toBeUndefined();
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

  it("drops unsafe keys and entries without content or error", async () => {
    const { mod, dir } = await freshCache();
    const poisoned = {
      searches: {},
      pages: {
        __proto__: { ts: Date.now(), title: "evil", content: "evil" },
        "https://empty": { ts: Date.now(), title: "t" },
        "https://empty-error": { ts: Date.now(), error: "" },
      },
    };
    writeFileSync(join(dir, "cache.json"), JSON.stringify(poisoned));
    const c = mod.loadCache();
    expect(Object.keys(c.pages)).toEqual([]);
    // A lookup for a missing URL must not inherit anything from the file.
    expect(c.pages["https://anything"]).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("evicts the oldest entries beyond the cap on save", async () => {
    const { mod, dir } = await freshCache(2);
    const c = mod.loadCache();
    const base = Date.now() - 60_000;
    c.pages["https://old"] = { ts: base, title: "old", content: "a" };
    c.pages["https://mid"] = { ts: base + 30_000, title: "mid", content: "b" };
    c.pages["https://new"] = { ts: base + 60_000, title: "new", content: "c" };
    mod.saveCache();
    const c2 = mod.loadCache();
    expect(Object.keys(c2.pages).sort()).toEqual(["https://mid", "https://new"]);
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
