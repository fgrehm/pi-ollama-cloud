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
/** Maximum UTF-8 payload estimate for one persisted cache entry. */
export const MAX_PERSISTED_ENTRY_BYTES = 256 * 1024;
/** Maximum UTF-8 payload estimate across all persisted cache entries. */
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

  function jsonStringBytes(value: string): number {
    let bytes = Buffer.byteLength(value) + 2;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code === 0x22 || code === 0x5c) {
        bytes += 1;
      } else if (code <= 0x1f) {
        // JSON.stringify uses two-byte escapes for these five controls and
        // six-byte unicode escapes for the remaining U+0000-U+001F range.
        bytes += code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 1 : 5;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) index += 1;
        else bytes += 3; // Buffer counts a lone surrogate as U+FFFD (3 bytes); JSON escapes it (6 bytes).
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        const previous = value.charCodeAt(index - 1);
        if (previous < 0xd800 || previous > 0xdbff) bytes += 3;
      }
    }
    return bytes;
  }

  function estimateEntryBytes(key: string, entry: SearchCacheEntry | PageCacheEntry): number {
    let bytes = jsonStringBytes(key) + 128;
    if ("q" in entry) {
      bytes += jsonStringBytes(entry.q);
      for (const result of entry.results) {
        bytes += jsonStringBytes(result.title) + jsonStringBytes(result.url) + jsonStringBytes(result.content) + 64;
      }
    } else {
      for (const value of [entry.title, entry.content, entry.error]) {
        if (value !== undefined) bytes += jsonStringBytes(value);
      }
      bytes += (entry.links ?? []).reduce((total, link) => total + jsonStringBytes(link) + 8, 0);
    }
    return bytes;
  }

  function saveCache(): void {
    const data = loadCache();
    for (const [key, entry] of Object.entries(data.searches)) if (!isFresh(entry)) delete data.searches[key];
    for (const [key, entry] of Object.entries(data.pages)) if (!isFresh(entry)) delete data.pages[key];
    // TTL bounds entry age; the cap bounds entry count so an aggressive session
    // cannot grow the file without limit.
    evictOldest(data.searches);
    evictOldest(data.pages);

    const persistedData: CacheData = { searches: { ...data.searches }, pages: { ...data.pages } };
    const entries = [
      ...Object.entries(persistedData.searches).map(([key, entry]) => ({ key, entry, map: persistedData.searches })),
      ...Object.entries(persistedData.pages).map(([key, entry]) => ({ key, entry, map: persistedData.pages })),
    ];
    for (const item of entries) {
      if (estimateEntryBytes(item.key, item.entry) > maxPersistedEntryBytes) delete item.map[item.key];
    }
    let estimatedBytes = entries.reduce(
      (total, item) => total + (item.map[item.key] ? estimateEntryBytes(item.key, item.entry) : 0),
      0,
    );
    while (estimatedBytes > maxCacheBytes) {
      const oldest = entries.filter((item) => item.map[item.key]).sort((a, b) => a.entry.ts - b.entry.ts)[0];
      if (!oldest) break;
      estimatedBytes -= estimateEntryBytes(oldest.key, oldest.entry);
      delete oldest.map[oldest.key];
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
