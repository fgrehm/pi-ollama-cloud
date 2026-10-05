import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CACHE_TTL_MS,
  type CacheData,
  createCache,
  FAIL_TTL_MS,
  isFresh,
  MAX_CACHE_BYTES,
  searchCacheKey,
} from "../cache.ts";

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

  it("normalizes loaded entries and nested search results before persistence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ollama-cache-"));
    const path = join(dir, "cache.json");
    const maxCacheBytes = 1024;
    const padding = "x".repeat(1024 * 1024);
    const input = {
      searches: {
        search: {
          ts: Date.now(),
          q: "query",
          padding,
          results: [{ title: "title", url: "https://search", content: "snippet", padding }],
        },
      },
      pages: {
        "https://page": { ts: Date.now(), title: "page", content: "body", padding },
      },
    };
    writeFileSync(path, JSON.stringify(input));
    const store = createCache({ path, maxPersistedEntryBytes: 512, maxCacheBytes });
    const cache = store.loadCache();

    expect(Object.keys(cache.searches.search)).toEqual(["ts", "q", "results"]);
    expect(cache.searches.search.results[0]).toEqual({ title: "title", url: "https://search", content: "snippet" });
    expect(Object.keys(cache.pages["https://page"])).toEqual(["ts", "title", "content"]);

    store.saveCache();
    const persisted: CacheData = JSON.parse(readFileSync(path, "utf8"));
    const persistedText = readFileSync(path, "utf8");

    expect(persisted.searches.search.results[0]).toEqual({ title: "title", url: "https://search", content: "snippet" });
    expect(persisted.pages["https://page"]).toEqual({
      ts: input.pages["https://page"].ts,
      title: "page",
      content: "body",
    });
    expect(persistedText).not.toContain(padding);
    expect(Buffer.byteLength(persistedText)).toBeLessThanOrEqual(maxCacheBytes);
    expect(Buffer.byteLength(JSON.stringify(persisted))).toBeLessThanOrEqual(maxCacheBytes);
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
        ["__proto__"]: { ts: Date.now(), title: "evil", content: "evil" },
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

  it("enforces entry size against escaped JSON while keeping oversized content in memory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ollama-cache-"));
    const path = join(dir, "cache.json");
    const maxEntryBytes = 1600;
    const mod = createCache({ path, maxPersistedEntryBytes: maxEntryBytes });
    const cache = mod.loadCache();
    const escaped = `${"\b\t\n\f\r".repeat(100)}${"\ud800".repeat(100)}${"\udc00".repeat(100)}`;
    const entry = { ts: Date.now(), title: "escaped", content: escaped };
    cache.pages["https://example.com"] = entry;

    mod.saveCache();

    expect(Buffer.byteLength(JSON.stringify({ "https://example.com": entry }))).toBeGreaterThan(maxEntryBytes);
    expect(cache.pages["https://example.com"]).toBe(entry);
    expect(createCache({ path }).loadCache().pages["https://example.com"]).toBeUndefined();
    expect(Buffer.byteLength(readFileSync(path, "utf8"))).toBeLessThanOrEqual(maxEntryBytes);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an entry whose exact serialized size exceeds the entry limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ollama-cache-"));
    const path = join(dir, "cache.json");
    const key = "\udc00";
    const entry = {
      ts: Date.now(),
      status: -Number.MAX_VALUE,
      title: "\udc00",
      content: `\udc00${"x".repeat(261_996)}`,
      links: null,
      error: "\udc00",
      errorType: "response-shape" as const,
    };
    const store = createCache({ path });
    store.loadCache().pages[key] = entry;

    expect(Buffer.byteLength(JSON.stringify({ [key]: entry }))).toBeGreaterThan(262_144);
    store.saveCache();

    const persisted = JSON.parse(readFileSync(path, "utf8"));
    expect(persisted.pages[key]).toBeUndefined();
    expect(Buffer.byteLength(readFileSync(path, "utf8"))).toBeLessThanOrEqual(MAX_CACHE_BYTES);
    rmSync(dir, { recursive: true, force: true });
  });

  it("accounts for keys and JSON wrappers when enforcing the aggregate byte limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ollama-cache-"));
    const path = join(dir, "cache.json");
    const store = createCache({ path, maxPersistedEntryBytes: 300_000 });
    const pages = store.loadCache().pages;
    for (let index = 0; index < 32; index += 1) {
      const suffix = String(index);
      const key = `\udc00${suffix}`;
      pages[key] = {
        ts: Date.now(),
        status: -Number.MAX_VALUE,
        title: "\udc00",
        content: `\udc00${"x".repeat(261_996 - suffix.length)}`,
        links: null,
        error: "\udc00",
        errorType: "response-shape",
      };
    }
    const unboundedBytes = Buffer.byteLength(JSON.stringify({ searches: {}, pages }));
    expect(unboundedBytes).toBeGreaterThan(MAX_CACHE_BYTES);

    store.saveCache();

    const text = readFileSync(path, "utf8");
    const persisted = JSON.parse(text);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_CACHE_BYTES);
    expect(Object.keys(persisted.pages).length).toBeLessThan(32);
    expect(persisted.pages["\udc0031"]).toBeDefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("honors exact serialized limits for empty and evicted map shapes", async () => {
    const base = Date.now() - 1000;
    const searchEntry = (ts: number, q: string) => ({ ts, q, results: [] });
    const pageEntry = (ts: number, title: string) => ({ ts, title, content: "" });
    const cacheData = (searches: CacheData["searches"], pages: CacheData["pages"]): CacheData => ({
      searches,
      pages,
    });
    const serializedSize = (data: CacheData) => Buffer.byteLength(JSON.stringify(data));
    const empty = cacheData({}, {});
    const onlySearch = cacheData({ only: searchEntry(base, "only") }, {});
    const onlyPage = cacheData({}, { only: pageEntry(base, "only") });
    const boundaryPage = cacheData({}, { k: pageEntry(base, "") });
    const newerSearch = cacheData({ newer: searchEntry(base + 3, "newer") }, {});
    const newerPage = cacheData({}, { newer: pageEntry(base + 3, "newer") });
    const bothMaps = cacheData({ newer: searchEntry(base + 3, "newer") }, { newer: pageEntry(base + 4, "newer") });
    expect(serializedSize(boundaryPage)).toBe(74);
    const scenarios: Array<{
      name: string;
      data: CacheData;
      maxCacheBytes: number;
    }> = [
      { name: "empty maps", data: empty, maxCacheBytes: serializedSize(empty) },
      { name: "one search", data: onlySearch, maxCacheBytes: serializedSize(onlySearch) - 1 },
      { name: "one page", data: onlyPage, maxCacheBytes: serializedSize(onlyPage) - 1 },
      { name: "72-byte page boundary", data: boundaryPage, maxCacheBytes: 72 },
      {
        name: "multiple searches after eviction",
        data: cacheData({ older: searchEntry(base + 1, "older"), newer: searchEntry(base + 3, "newer") }, {}),
        maxCacheBytes: serializedSize(newerSearch) - 1,
      },
      {
        name: "multiple pages after eviction",
        data: cacheData({}, { older: pageEntry(base + 1, "older"), newer: pageEntry(base + 3, "newer") }),
        maxCacheBytes: serializedSize(newerPage) - 1,
      },
      {
        name: "both maps after first eviction",
        data: cacheData({ older: searchEntry(base + 1, "older") }, { newer: pageEntry(base + 3, "newer") }),
        maxCacheBytes: serializedSize(newerPage) - 1,
      },
      {
        name: "both maps after multiple evictions",
        data: cacheData(
          { older: searchEntry(base + 1, "older"), newer: searchEntry(base + 3, "newer") },
          { older: pageEntry(base + 2, "older"), newer: pageEntry(base + 4, "newer") },
        ),
        maxCacheBytes: serializedSize(bothMaps) - 1,
      },
    ];

    for (const scenario of scenarios) {
      const dir = mkdtempSync(join(tmpdir(), "ollama-cache-"));
      const path = join(dir, "cache.json");
      const store = createCache({ path, maxCacheBytes: scenario.maxCacheBytes });
      Object.assign(store.loadCache().searches, scenario.data.searches);
      Object.assign(store.loadCache().pages, scenario.data.pages);
      store.saveCache();

      const text = readFileSync(path, "utf8");
      expect(Buffer.byteLength(text), scenario.name).toBeLessThanOrEqual(scenario.maxCacheBytes);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("evicts oldest entries to keep the persisted cache within its byte budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ollama-cache-"));
    const path = join(dir, "cache.json");
    const mod = createCache({ path, maxCacheBytes: 1000 });
    const cache = mod.loadCache();
    const base = Date.now() - 1000;
    cache.pages["https://old"] = { ts: base, title: "old", content: "\n".repeat(300) };
    cache.pages["https://new"] = { ts: base + 1, title: "new", content: "\n".repeat(300) };

    mod.saveCache();

    const persisted = createCache({ path }).loadCache();
    expect(Object.keys(persisted.pages)).toEqual(["https://new"]);
    expect(Buffer.byteLength(readFileSync(path, "utf8"))).toBeLessThanOrEqual(1000);
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
