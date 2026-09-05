/**
 * Ollama Cloud web tools: ollama_web_search and ollama_web_fetch.
 *
 * Self-contained module. Depends on:
 *   - models.ts       - only for OLLAMA_BASE URL constant
 *   - pi-coding-agent - ExtensionAPI, ExtensionContext, keyHint, truncateToVisualLines
 *   - pi-tui          - Text, truncateToWidth
 *   - utils.ts        - fetchJsonWithTimeout
 *   - cache.ts        - disk-backed cache (24h success / 15min failure TTL)
 * Does NOT depend on provider registration or model fetching internals.
 *
 * API key resolution: each tool's execute() receives an ExtensionContext whose
 * modelRegistry resolves the registered provider's key (runtime/CLI overrides,
 * the registered apiKey: "$OLLAMA_API_KEY" config, and stored auth.json). The
 * OLLAMA_API_KEY env var is a fallback for when the provider is not yet
 * registered at tool-call time. This avoids direct AuthStorage access, which is
 * not part of the public pi-coding-agent API on 0.80.8+.
 */

import {
  type AgentToolResult,
  type ExtensionAPI,
  keyHint,
  type Theme,
  type ToolRenderResultOptions,
  truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { type CacheStore, defaultCache, type PageCacheEntry, type SearchResult, searchCacheKey } from "./cache.ts";
import { OLLAMA_BASE } from "./models.ts";
import { envInt, fetchJsonWithTimeout, getCloudApiKey, httpError } from "./utils.ts";

// --- Types ---

interface SearchResponse {
  results: Array<{
    title: string;
    url: string;
    content: string;
  }>;
}

interface FetchResponse {
  title: string;
  content: string;
  links: string[] | null;
}

// --- Helpers ---

const WEB_TOOLS_TIMEOUT_MS = 15000;
// Search snippets and fetch chunks are capped so a single call never floods the
// context window; the agent pages through long pages with offset/full.
const SNIPPET_LIMIT = envInt("PI_OLLAMA_SEARCH_SNIPPET_CHARS", 500);
const READ_CHUNK = envInt("PI_OLLAMA_SEARCH_CHUNK_CHARS", 3000);

/** Throw a no-API-key error. */
function noApiKeyError(): never {
  throw new Error("No Ollama Cloud API key configured. Set OLLAMA_API_KEY or add to auth.json.");
}

const PREVIEW_LINES = 8;

/**
 * Build a renderResult handler that shows a truncated preview when collapsed
 * and the full output when expanded. Follows the bash tool pattern.
 */
function createRenderResult() {
  return (
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: {
      invalidate: () => void;
      lastComponent: Component | undefined;
      isError: boolean;
      state: { cachedWidth?: number; cachedLines?: string[]; cachedSkipped?: number };
    },
  ) => {
    const state = context.state;
    const output = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();
    const styledOutput = output
      .split("\n")
      .map((line: string) => theme.fg("toolOutput", line))
      .join("\n");

    if (options.expanded || context.isError) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(context.isError ? styledOutput : `\n${styledOutput}`);
      return text;
    }

    return {
      render: (width: number) => {
        if (state.cachedWidth !== width) {
          const preview = truncateToVisualLines(styledOutput, PREVIEW_LINES, width);
          state.cachedLines = preview.visualLines;
          state.cachedSkipped = preview.skippedCount;
          state.cachedWidth = width;
        }
        if (state.cachedSkipped && state.cachedSkipped > 0) {
          const hint =
            theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
            ` ${keyHint("app.tools.expand", "to expand")})`;
          return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
        }
        return ["", ...(state.cachedLines ?? [])];
      },
      invalidate: () => {
        state.cachedWidth = undefined;
        state.cachedLines = undefined;
        state.cachedSkipped = undefined;
      },
    };
  };
}

/** Validate a parsed web_search response: must have a results array of well-formed entries. */
export function isSearchResponse(data: unknown): data is SearchResponse {
  if (data == null || typeof data !== "object") return false;
  const results = (data as SearchResponse).results;
  return (
    Array.isArray(results) &&
    results.every((r) => typeof r.title === "string" && typeof r.url === "string" && typeof r.content === "string")
  );
}

/** Validate a parsed web_fetch response: must have string title/content and a links array of strings (or null). */
export function isFetchResponse(data: unknown): data is FetchResponse {
  if (data == null || typeof data !== "object") return false;
  const d = data as FetchResponse;
  return (
    typeof d.title === "string" &&
    typeof d.content === "string" &&
    (d.links === null || (Array.isArray(d.links) && d.links.every((l) => typeof l === "string")))
  );
}

/** Build a failure message with likely causes and next steps (thrown, per the AgentToolResult contract). */
function fetchFailureMessage(
  url: string,
  entry: PageCacheEntry,
  failureState: "cached" | "live-cached" | "live-uncached",
): string {
  const lines = [
    `Ollama Cloud fetch failed: ${url}`,
    `API error: ${entry.error}`,
    failureState === "cached"
      ? "Status: from cache (failure cached; pass refresh=true to force a live retry)"
      : failureState === "live-cached"
        ? "Status: live request failed (failure cached for 15 min; pass refresh=true to force a live retry)"
        : "Status: live request failed (not cached; the next call retries the API)",
  ];
  if (entry.status === 401 || entry.status === 403) {
    lines.push(
      "Likely cause: authentication error.",
      "Suggestion: check your API key in OLLAMA_API_KEY or auth.json, then retry (auth failures are not cached).",
    );
  } else if (entry.status === 429) {
    lines.push("Likely cause: rate limited.", "Suggestion: try again shortly (rate-limit failures are not cached).");
  } else {
    lines.push(
      "Likely cause: anti-bot / login wall, JS-rendered page, or malformed URL.",
      "Suggestion: 1) use ollama_web_search for the site/topic; 2) check the URL; 3) retrying with offset/full will also fail — use refresh=true only if you believe the failure was transient.",
    );
  }
  return lines.join("\n");
}

// --- Registrations ---

export function registerWebSearchTool(pi: ExtensionAPI, cacheStore: CacheStore = defaultCache) {
  pi.registerTool({
    name: "ollama_web_search",
    label: "Ollama Web Search",
    description:
      "Search the web for real-time information using Ollama Cloud's web search API. " +
      "Returns up to max_results results (default 5, max 10; title, URL, 500-char snippet; [truncated] means the source is longer — " +
      "pass expand=<index> to get that result's full content from the cached search, 0 extra API calls). " +
      "Results are cached for 24h: the same query within that window costs 0 API calls. " +
      "Pass refresh=true to bypass the cache and re-call the API (e.g. results look stale). " +
      "Requires an Ollama Cloud API key.",
    parameters: Type.Object({
      query: Type.String({ description: "The search query to execute" }),
      max_results: Type.Optional(
        Type.Integer({
          description: "Maximum number of search results to return (default: 5, max: 10)",
          default: 5,
          minimum: 1,
          maximum: 10,
        }),
      ),
      refresh: Type.Optional(
        Type.Boolean({
          description:
            "Bypass the cached search and re-call the API (default: false). The fresh result replaces the cache entry.",
          default: false,
        }),
      ),
      expand: Type.Optional(
        Type.Integer({
          description:
            "Return the full content of this result (1-based index) instead of snippets. " +
            "Served from the cached search — 0 API calls if the query was searched recently.",
          minimum: 1,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const apiKey = await getCloudApiKey(ctx);
      if (!apiKey) {
        noApiKeyError();
      }

      const maxResults = params.max_results ?? 5;
      const cache = cacheStore.loadCache();
      const key = searchCacheKey(params.query, maxResults);
      const cached = cache.searches[key];
      let live = false;
      let results: SearchResult[];

      if (!params.refresh && cacheStore.isFresh(cached)) {
        results = cached!.results;
      } else {
        live = true;
        const res = await fetchJsonWithTimeout<SearchResponse>(
          `${OLLAMA_BASE}/api/web_search`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              query: params.query,
              max_results: maxResults,
            }),
          },
          WEB_TOOLS_TIMEOUT_MS,
          signal,
        );

        if (!res.ok) {
          if (res.status === 0) {
            // Transport failure (timeout, abort, network); not a server answer.
            throw new Error(
              `Ollama Cloud search failed: transport error (${res.error ?? "unknown"}). Not cached; the next call retries the API.`,
            );
          }
          httpError("search", res.status, res.error);
        }
        if (!isSearchResponse(res.data)) {
          throw new Error("Web search failed: unexpected response shape from the API.");
        }

        results = res.data.results.map((r) => ({
          title: r.title,
          url: r.url,
          content: r.content,
        }));
        cache.searches[key] = { ts: Date.now(), q: params.query, results };
        cacheStore.saveCache();
      }

      // Expand mode: return the full content of one result from the cached search.
      if (params.expand !== undefined) {
        const idx = params.expand;
        if (idx < 1 || idx > results.length) {
          throw new Error(
            `Web search expand: index ${idx} out of range (this search has ${results.length} results). ` +
              "Use ollama_web_fetch to read a specific URL instead.",
          );
        }
        const r = results[idx - 1];
        return {
          content: [
            {
              type: "text",
              text: `Result ${idx} of "${params.query}" (full content, ${r.content.length} chars):\n\n${r.content}\n\n${live ? "# live query" : "# from cache"}`,
            },
          ],
          details: { results: [r] },
        };
      }

      const formatted = results
        .map((r, i) => {
          const truncated = r.content.length > SNIPPET_LIMIT;
          return `${i + 1}. ${truncated ? "[truncated]" : "[complete]"} ${r.title}\n   URL: ${r.url}\n   ${r.content.slice(0, SNIPPET_LIMIT)}`;
        })
        .join("\n\n");

      const hasTruncated = results.some((r) => r.content.length > SNIPPET_LIMIT);
      const expandHint = hasTruncated
        ? `\n\nExpand: call ollama_web_search(query="${params.query}", expand=<index>) to read a [truncated] result in full — 0 extra API calls.`
        : "";

      return {
        content: [
          {
            type: "text",
            text: `${formatted || "No results found."}${expandHint}\n\n${live ? "# live query" : "# from cache"}`,
          },
        ],
        details: { results },
      };
    },
    renderCall(args, theme, _context) {
      const display = args.query ? `ollama_web_search("${args.query}")` : "ollama_web_search";
      return new Text(theme.fg("toolTitle", display), 0, 0);
    },
    renderResult: createRenderResult(),
  });
}

export function registerWebFetchTool(pi: ExtensionAPI, cacheStore: CacheStore = defaultCache) {
  pi.registerTool({
    name: "ollama_web_fetch",
    label: "Ollama Web Fetch",
    description:
      "Fetch and extract text content from a web page URL using Ollama Cloud's web fetch API. " +
      "Returns the page title, a 3000-char slice of the content, and links. Pages are cached for 24h. " +
      "Pass offset=N to continue reading from char N (the output tells you the next offset), or " +
      "full=true to get all remaining content from offset in one call. A failed URL is cached for 15 min " +
      "— retrying it within that window costs 0 API calls and fails the same way; pass refresh=true to " +
      "force a live retry. Requires an Ollama Cloud API key.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch and extract content from", format: "uri" }),
      offset: Type.Optional(
        Type.Integer({
          description: "Start reading from this character index (default: 0)",
          default: 0,
          minimum: 0,
        }),
      ),
      full: Type.Optional(
        Type.Boolean({
          description: "Return all remaining content from offset in one call (default: false)",
          default: false,
        }),
      ),
      refresh: Type.Optional(
        Type.Boolean({
          description:
            "Bypass the cached page (or cached failure) and re-call the API (default: false). The fresh result replaces the cache entry.",
          default: false,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const apiKey = await getCloudApiKey(ctx);
      if (!apiKey) {
        noApiKeyError();
      }

      const cache = cacheStore.loadCache();
      let entry = cache.pages[params.url];
      let live = false;
      let cacheable = true;

      if (params.refresh || !cacheStore.isFresh(entry)) {
        live = true;
        const res = await fetchJsonWithTimeout<FetchResponse>(
          `${OLLAMA_BASE}/api/web_fetch`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ url: params.url }),
          },
          WEB_TOOLS_TIMEOUT_MS,
          signal,
        );

        if (!res.ok) {
          entry = { ts: Date.now(), status: res.status, error: `HTTP ${res.status}: ${res.error ?? "unknown error"}` };
        } else if (!isFetchResponse(res.data)) {
          entry = { ts: Date.now(), error: "unexpected response shape from the API" };
        } else {
          entry = {
            ts: Date.now(),
            title: res.data.title,
            content: res.data.content,
            links: res.data.links,
          };
        }
        // Auth, rate-limit, and transport failures (status 0: timeout, abort,
        // DNS/connection errors) are not negative-cached: a fixed key, an
        // expired rate-limit window, or a transient network issue should let
        // the next retry through.
        cacheable = entry.status !== 0 && !(entry.status === 401 || entry.status === 403 || entry.status === 429);
        if (cacheable) {
          cache.pages[params.url] = entry;
          cacheStore.saveCache();
        }
      }

      if (entry.error) {
        throw new Error(
          fetchFailureMessage(params.url, entry, live ? (cacheable ? "live-cached" : "live-uncached") : "cached"),
        );
      }

      const content = entry.content ?? "";
      const total = content.length;
      const start = params.offset ?? 0;
      const end = params.full ? total : Math.min(start + READ_CHUNK, total);
      const lines = [
        `Title: ${entry.title} (${total} chars total)`,
        start >= total
          ? "Already at the end, no more content."
          : `Chars ${start + 1}-${end} of ${total}${end < total ? ` (${total - end} remaining)` : ""}:`,
        content.slice(start, end),
      ];
      if (!params.full && end < total) {
        lines.push(`\nContinue: call ollama_web_fetch(url="${params.url}", offset=${end})`);
      }
      if ((params.offset ?? 0) === 0 && !params.full) {
        const links = entry.links ?? [];
        lines.push(`\nLinks (${links.length}):`);
        lines.push(...links.slice(0, 10).map((l) => `  - ${l}`));
      }
      lines.push(live ? "# live query" : "# from cache");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { title: entry.title, totalChars: total, links: entry.links },
      };
    },
    renderCall(args, theme, _context) {
      const display = args.url ? `ollama_web_fetch("${args.url}")` : "ollama_web_fetch";
      return new Text(theme.fg("toolTitle", display), 0, 0);
    },
    renderResult: createRenderResult(),
  });
}
