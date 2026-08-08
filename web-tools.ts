/**
 * Ollama Cloud web tools: ollama_web_search and ollama_web_fetch.
 *
 * Self-contained module. Depends on:
 *   - models.ts       - only for OLLAMA_BASE URL constant
 *   - pi-coding-agent - ExtensionAPI, ExtensionContext, keyHint, truncateToVisualLines
 *   - pi-tui          - Text, truncateToWidth
 *   - utils.ts        - fetchJsonWithTimeout
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
  type ExtensionContext,
  keyHint,
  type Theme,
  type ToolRenderResultOptions,
  truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { OLLAMA_BASE } from "./models.ts";
import { fetchJsonWithTimeout } from "./utils.ts";

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

/**
 * Resolve the Ollama Cloud API key for a tool execution.
 *
 * Prefers the canonical provider auth chain (ctx.modelRegistry.getApiKeyForProvider),
 * which honors runtime/CLI key overrides, the registered
 * apiKey: "$OLLAMA_API_KEY" config, and stored auth.json credentials. Falls back
 * to the OLLAMA_API_KEY env var for the case where the provider is not yet
 * registered at tool-call time.
 *
 * Exported for unit testing.
 */
export async function getCloudApiKey(ctx: Pick<ExtensionContext, "modelRegistry">): Promise<string | undefined> {
  return (await ctx.modelRegistry.getApiKeyForProvider("ollama-cloud")) ?? process.env.OLLAMA_API_KEY;
}

/** Throw a no-API-key error. */
function noApiKeyError(): never {
  throw new Error("No Ollama Cloud API key configured. Set OLLAMA_API_KEY or add to auth.json.");
}

/** Throw a search error for a non-ok result, mapping distinct status codes. */
function searchError(status: number, error?: string): never {
  if (status === 401 || status === 403) {
    throw new Error(
      "Ollama Cloud search failed: authentication error. " + "Check your API key in OLLAMA_API_KEY or auth.json.",
    );
  }
  if (status === 429) {
    throw new Error("Ollama Cloud search failed: rate limited. Try again shortly.");
  }
  if (status >= 500) {
    throw new Error(`Ollama Cloud search failed: server error (status ${status}). Try again shortly.`);
  }
  throw new Error(
    `Ollama Cloud search failed: unexpected response (status ${status}${error ? `: ${error}` : ""}). Try again shortly.`,
  );
}

/** Throw a fetch error for a non-ok result, mapping distinct status codes. */
function fetchError(status: number, error?: string): never {
  if (status === 401 || status === 403) {
    throw new Error(
      "Ollama Cloud fetch failed: authentication error. " + "Check your API key in OLLAMA_API_KEY or auth.json.",
    );
  }
  if (status === 429) {
    throw new Error("Ollama Cloud fetch failed: rate limited. Try again shortly.");
  }
  if (status >= 500) {
    throw new Error(`Ollama Cloud fetch failed: server error (status ${status}). Try again shortly.`);
  }
  throw new Error(
    `Ollama Cloud fetch failed: unexpected response (status ${status}${error ? `: ${error}` : ""}). Try again shortly.`,
  );
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

// --- Registrations ---

export function registerWebSearchTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ollama_web_search",
    label: "Ollama Web Search",
    description:
      "Search the web for real-time information using Ollama Cloud's web search API. " +
      "Returns relevant results with titles, URLs, and content snippets. " +
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
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const apiKey = await getCloudApiKey(ctx);
      if (!apiKey) {
        noApiKeyError();
      }

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
            max_results: params.max_results ?? 5,
          }),
        },
        WEB_TOOLS_TIMEOUT_MS,
        signal,
      );

      if (!res.ok) {
        searchError(res.status, res.error);
      }
      if (!isSearchResponse(res.data)) {
        throw new Error("Web search failed: unexpected response shape from the API.");
      }

      const formatted = res.data.results
        .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.content}`)
        .join("\n\n");

      return {
        content: [{ type: "text", text: formatted || "No results found." }],
        details: { results: res.data.results },
      };
    },
    renderCall(args, theme, _context) {
      const display = args.query ? `ollama_web_search("${args.query}")` : "ollama_web_search";
      return new Text(theme.fg("toolTitle", display), 0, 0);
    },
    renderResult: createRenderResult(),
  });
}

export function registerWebFetchTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ollama_web_fetch",
    label: "Ollama Web Fetch",
    description:
      "Fetch and extract text content from a web page URL using Ollama Cloud's web fetch API. " +
      "Returns the page title, main content, and links found on the page. " +
      "Requires an Ollama Cloud API key.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch and extract content from", format: "uri" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const apiKey = await getCloudApiKey(ctx);
      if (!apiKey) {
        noApiKeyError();
      }

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
        fetchError(res.status, res.error);
      }
      if (!isFetchResponse(res.data)) {
        throw new Error("Web fetch failed: unexpected response shape from the API.");
      }

      const data = res.data;
      const formatted = [
        `Title: ${data.title}`,
        "",
        "Content:",
        data.content,
        "",
        `Links found: ${data.links?.length ?? 0}`,
        ...(data.links?.slice(0, 10).map((l) => `  - ${l}`) ?? []),
      ].join("\n");

      return {
        content: [{ type: "text", text: formatted }],
        details: { title: data.title, content: data.content, links: data.links },
      };
    },
    renderCall(args, theme, _context) {
      const display = args.url ? `ollama_web_fetch("${args.url}")` : "ollama_web_fetch";
      return new Text(theme.fg("toolTitle", display), 0, 0);
    },
    renderResult: createRenderResult(),
  });
}
