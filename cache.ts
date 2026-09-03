/**
 * Disk-backed cache for the Ollama Cloud web tools.
 *
 * Successes live 24h; failures are negative-cached for 15 min so retrying a
 * dead page costs 0 extra API calls. Same query/URL within TTL is served from
 * cache.
 *
 * Tuning (env vars, read once at module load):
 *   PI_OLLAMA_SEARCH_TTL_HOURS        success TTL (default 24)
 *   PI_OLLAMA_SEARCH_FAIL_TTL_MINUTES failure TTL (default 15)
 *   PI_OLLAMA_SEARCH_CACHE_PATH       cache file location (default <pi agent home>/cache/pi-ollama-cloud/cache.json)
 */

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
  /** Full content as returned by the search API (not truncated); display truncation happens in web-tools.ts. */
  content: string;
}

export interface SearchCacheEntry {
  ts: number;
  q: string;
  results: SearchResult[];
}

export interface PageCacheEntry {
  ts: number;
  /** HTTP status for failed fetches; drives status-specific diagnostics in web-tools.ts. */
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

let cacheData: CacheData | null = null;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function loadCache(): CacheData {
  if (cacheData) return cacheData;
  try {
    const raw: unknown = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    if (isRecord(raw) && isRecord(raw.searches) && isRecord(raw.pages)) {
      cacheData = raw as unknown as CacheData;
      return cacheData;
    }
  } catch {
    // first run or corrupt file — start fresh
  }
  cacheData = { searches: {}, pages: {} };
  return cacheData;
}

export function saveCache(): void {
  const data = loadCache();
  // Prune expired entries before writing so the file does not grow unbounded.
  // O(n) scan on every save, negligible at this cache size.
  for (const [key, entry] of Object.entries(data.searches)) if (!isFresh(entry)) delete data.searches[key];
  for (const [key, entry] of Object.entries(data.pages)) if (!isFresh(entry)) delete data.pages[key];
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    const tmp = `${CACHE_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, CACHE_PATH);
  } catch {
    // cache is best-effort; a failed write must not break the tool call
  }
}

/** Fresh = entry exists and within TTL. Failed entries get a shorter TTL (retry sooner). */
export function isFresh(entry: { ts: number; error?: string } | undefined): boolean {
  if (!entry) return false;
  const ttl = entry.error ? FAIL_TTL_MS : CACHE_TTL_MS;
  return Date.now() - entry.ts < ttl;
}

export function searchCacheKey(query: string, maxResults: number): string {
  return createHash("sha1").update(`${query}\n${maxResults}`).digest("hex");
}
