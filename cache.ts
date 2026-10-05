import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { envInt } from "./utils.ts";

export const CACHE_PATH =
  process.env.PI_OLLAMA_SEARCH_CACHE_PATH ?? join(getAgentDir(), "cache", "pi-ollama-cloud", "cache.json");
export const CACHE_TTL_MS = envInt("PI_OLLAMA_SEARCH_TTL_HOURS", 24) * 60 * 60 * 1000;
export const FAIL_TTL_MS = envInt("PI_OLLAMA_SEARCH_FAIL_TTL_MINUTES", 15) * 60 * 1000;
/** Max entries per map (searches/pages); oldest-ts entries are evicted beyond this. */
export const MAX_ENTRIES = envInt("PI_OLLAMA_SEARCH_MAX_ENTRIES", 500);
/** Maximum serialized UTF-8 size for one persisted entry, including its key. */
export const MAX_PERSISTED_ENTRY_BYTES = 256 * 1024;
/** Maximum serialized UTF-8 size of the complete persisted cache file. */
export const MAX_CACHE_BYTES = 8 * 1024 * 1024;

export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

export interface SearchCacheEntry {
  ts: number;
  q: string;
  results: SearchResult[];
}

export interface PageCacheEntry {
  ts: number;
  status?: number;
  title?: string;
  content?: string;
  links?: string[] | null;
  error?: string;
  errorType?: "response-shape";
}

export interface CacheData {
  searches: Record<string, SearchCacheEntry>;
  pages: Record<string, PageCacheEntry>;
}

interface CacheOptions {
  path: string;
  ttlMs: number;
  failTtlMs: number;
  maxEntries: number;
  maxPersistedEntryBytes: number;
  maxCacheBytes: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Keys that must never come from a parsed JSON file (prototype pollution). */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isSafeKey(key: string): boolean {
  return !UNSAFE_KEYS.has(key);
}

/** Shallow shape checks so a partially corrupted cache file degrades instead of crashing tool calls. */
function isSearchEntry(v: unknown): v is SearchCacheEntry {
  return (
    isRecord(v) &&
    typeof v.ts === "number" &&
    typeof v.q === "string" &&
    Array.isArray(v.results) &&
    v.results.every(
      (r) => isRecord(r) && typeof r.title === "string" && typeof r.url === "string" && typeof r.content === "string",
    )
  );
}

function normalizeSearchEntry(entry: SearchCacheEntry): SearchCacheEntry {
  return {
    ts: entry.ts,
    q: entry.q,
    results: entry.results.map(({ title, url, content }) => ({ title, url, content })),
  };
}

function isPageEntry(v: unknown): v is PageCacheEntry {
  if (!isRecord(v) || typeof v.ts !== "number") return false;
  const fieldsValid =
    (v.status === undefined || typeof v.status === "number") &&
    (v.title === undefined || typeof v.title === "string") &&
    (v.content === undefined || typeof v.content === "string") &&
    (v.links === null ||
      v.links === undefined ||
      (Array.isArray(v.links) && v.links.every((l) => typeof l === "string"))) &&
    (v.error === undefined || (typeof v.error === "string" && v.error !== "")) &&
    (v.errorType === undefined || v.errorType === "response-shape");
  if (!fieldsValid) return false;
  // Must be either a real failure or a real success; anything else (e.g. an
  // entry with neither content nor a non-empty error) would render as a fake
  // empty success.
  return (
    (typeof v.error === "string" && v.error !== "") || (typeof v.title === "string" && typeof v.content === "string")
  );
}

function normalizePageEntry(entry: PageCacheEntry): PageCacheEntry {
  const normalized: PageCacheEntry = { ts: entry.ts };
  if (entry.status !== undefined) normalized.status = entry.status;
  if (entry.title !== undefined) normalized.title = entry.title;
  if (entry.content !== undefined) normalized.content = entry.content;
  if (entry.links !== undefined) normalized.links = entry.links;
  if (entry.error !== undefined) normalized.error = entry.error;
  if (entry.errorType !== undefined) normalized.errorType = entry.errorType;
  return normalized;
}

export interface CacheStore {
  loadCache(): CacheData;
  saveCache(): void;
  isFresh(entry: { ts: number; error?: string } | undefined): boolean;
}

export function createCache(options: Partial<CacheOptions> = {}): CacheStore {
  const path = options.path ?? CACHE_PATH;
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  const failTtlMs = options.failTtlMs ?? FAIL_TTL_MS;
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const maxPersistedEntryBytes = options.maxPersistedEntryBytes ?? MAX_PERSISTED_ENTRY_BYTES;
  const maxCacheBytes = options.maxCacheBytes ?? MAX_CACHE_BYTES;
  let cacheData: CacheData | null = null;

  function loadCache(): CacheData {
    if (cacheData) return cacheData;
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isRecord(raw) && isRecord(raw.searches) && isRecord(raw.pages)) {
        // Per-entry validation: drop poisoned entries so a partially corrupt
        // file degrades to "those entries are gone" instead of crashing calls.
        cacheData = { searches: {}, pages: {} };
        for (const [key, entry] of Object.entries(raw.searches)) {
          if (isSafeKey(key) && isSearchEntry(entry)) cacheData.searches[key] = normalizeSearchEntry(entry);
        }
        for (const [key, entry] of Object.entries(raw.pages)) {
          if (isSafeKey(key) && isPageEntry(entry)) cacheData.pages[key] = normalizePageEntry(entry);
        }
        return cacheData;
      }
    } catch {
      // First run or corrupt file, start fresh.
    }
    cacheData = { searches: {}, pages: {} };
    return cacheData;
  }

  function isFresh(entry: { ts: number; error?: string } | undefined): boolean {
    if (!entry) return false;
    // A future ts (hand-edited file) would otherwise be fresh forever; treat as stale.
    if (entry.ts > Date.now()) return false;
    return Date.now() - entry.ts < (entry.error ? failTtlMs : ttlMs);
  }

  function evictOldest(map: Record<string, { ts: number }>): void {
    const keys = Object.keys(map);
    if (keys.length <= maxEntries) return;
    const overflow = keys.sort((a, b) => map[a].ts - map[b].ts).slice(0, keys.length - maxEntries);
    for (const key of overflow) delete map[key];
  }

  function serializedEntrySize(
    key: string,
    entry: SearchCacheEntry | PageCacheEntry,
  ): {
    entryBytes: number;
    propertyBytes: number;
  } {
    // The one-property object includes the JSON-escaped cache key and braces.
    // Removing only those two braces yields the exact property size in a map.
    const onePropertyObject = JSON.stringify({ [key]: entry });
    const entryBytes = Buffer.byteLength(onePropertyObject);
    return { entryBytes, propertyBytes: entryBytes - 2 };
  }

  function saveCache(): void {
    const data = loadCache();
    for (const [key, entry] of Object.entries(data.searches)) if (!isFresh(entry)) delete data.searches[key];
    for (const [key, entry] of Object.entries(data.pages)) if (!isFresh(entry)) delete data.pages[key];
    // Prune stale and over-count entries before applying serialized-byte limits.
    evictOldest(data.searches);
    evictOldest(data.pages);

    const persistedData: CacheData = { searches: { ...data.searches }, pages: { ...data.pages } };
    const searches = Object.entries(persistedData.searches).map(([key, entry]) => ({
      ...serializedEntrySize(key, entry),
      key,
      entry,
      map: persistedData.searches,
    }));
    const pages = Object.entries(persistedData.pages).map(([key, entry]) => ({
      ...serializedEntrySize(key, entry),
      key,
      entry,
      map: persistedData.pages,
    }));
    const entries = [...searches, ...pages];
    for (const item of entries) {
      if (item.entryBytes > maxPersistedEntryBytes) delete item.map[item.key];
    }

    function serializedCacheSize(): number {
      let bytes = Buffer.byteLength('{"searches":{},"pages":{}}');
      for (const mapEntries of [searches, pages]) {
        const persistedEntries = mapEntries.filter((item) => item.map[item.key] !== undefined);
        if (persistedEntries.length === 0) continue;
        // The empty-map braces are already included in the base size.
        bytes += persistedEntries.reduce((total, item) => total + item.propertyBytes, 0);
        bytes += persistedEntries.length - 1;
      }
      return bytes;
    }

    let persistedBytes = serializedCacheSize();
    const oldestFirst = entries.sort((a, b) => a.entry.ts - b.entry.ts);
    for (const item of oldestFirst) {
      if (persistedBytes <= maxCacheBytes) break;
      if (item.map[item.key] === undefined) continue;
      delete item.map[item.key];
      persistedBytes = serializedCacheSize();
    }
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // Use a unique temporary path so concurrent processes cannot overwrite
      // one another's in-progress writes.
      const tmp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        // 0o600: the cache stores full page content and URLs, which can embed
        // credentials in query strings; it should not be world-readable.
        writeFileSync(tmp, JSON.stringify(persistedData), { mode: 0o600 });
        renameSync(tmp, path);
        // Fix perms of a file written by a pre-0600 version.
        chmodSync(path, 0o600);
      } catch (error) {
        rmSync(tmp, { force: true });
        throw error;
      }
    } catch {
      // Cache is best-effort; a failed write must not break the tool call.
    }
  }

  return { loadCache, saveCache, isFresh };
}

export const defaultCache = createCache();
export const loadCache = defaultCache.loadCache;
export const saveCache = defaultCache.saveCache;
export const isFresh = defaultCache.isFresh;

export function searchCacheKey(query: string, maxResults: number): string {
  return createHash("sha1").update(`${query}\n${maxResults}`).digest("hex");
}
