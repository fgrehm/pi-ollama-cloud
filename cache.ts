import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { envInt } from "./utils.ts";

export const CACHE_PATH =
  process.env.PI_OLLAMA_SEARCH_CACHE_PATH ?? join(getAgentDir(), "cache", "pi-ollama-cloud", "cache.json");
export const CACHE_TTL_MS = envInt("PI_OLLAMA_SEARCH_TTL_HOURS", 24) * 60 * 60 * 1000;
export const FAIL_TTL_MS = envInt("PI_OLLAMA_SEARCH_FAIL_TTL_MINUTES", 15) * 60 * 1000;

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
}

export interface CacheData {
  searches: Record<string, SearchCacheEntry>;
  pages: Record<string, PageCacheEntry>;
}

interface CacheOptions {
  path: string;
  ttlMs: number;
  failTtlMs: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

function isPageEntry(v: unknown): v is PageCacheEntry {
  return (
    isRecord(v) &&
    typeof v.ts === "number" &&
    (v.status === undefined || typeof v.status === "number") &&
    (v.title === undefined || typeof v.title === "string") &&
    (v.content === undefined || typeof v.content === "string") &&
    (v.links === null ||
      v.links === undefined ||
      (Array.isArray(v.links) && v.links.every((l) => typeof l === "string"))) &&
    (v.error === undefined || typeof v.error === "string")
  );
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
          if (isSearchEntry(entry)) cacheData.searches[key] = entry;
        }
        for (const [key, entry] of Object.entries(raw.pages)) {
          if (isPageEntry(entry)) cacheData.pages[key] = entry;
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

  function saveCache(): void {
    const data = loadCache();
    for (const [key, entry] of Object.entries(data.searches)) if (!isFresh(entry)) delete data.searches[key];
    for (const [key, entry] of Object.entries(data.pages)) if (!isFresh(entry)) delete data.pages[key];
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, path);
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
