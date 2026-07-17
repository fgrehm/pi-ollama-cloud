/**
 * Ollama Cloud web tools: ollama_web_search and ollama_web_fetch.
 *
 * Self-contained module. Depends on:
 *   - models.ts       - only for OLLAMA_BASE URL constant
 *   - pi-coding-agent - ExtensionAPI, keyHint, truncateToVisualLines
 *   - pi-tui          - Text, truncateToWidth
 * Does NOT depend on provider registration or model fetching internals.
 *
 * Auth note: pi removed `AuthStorage` from its public exports in 0.80.8 and
 * added `readStoredCredential` in the same release. A static named import of
 * either symbol is a hard link-error on the other version range, so we use a
 * namespace import and feature-detect at runtime to stay compatible with
 * pi 0.74.0 through 0.80.10+.
 */

import * as piAgent from "@earendil-works/pi-coding-agent";
import { type ExtensionAPI, keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { OLLAMA_BASE } from "./models.ts";

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
  links: string[];
}

// --- Helpers ---

// pi exports `readStoredCredential` (>= 0.80.8) and `AuthStorage` (<= 0.80.7);
// only one is present on any given version. Probe the namespace at runtime
// rather than importing either by name so the extension loads everywhere.
type PiAuthModule = {
  AuthStorage?: {
    new (): {
      create(): {
        getApiKey(provider: string): Promise<string | undefined>;
      };
    };
  };
  readStoredCredential?: (provider: string) => { type: string; key?: string } | undefined;
};

async function getCloudApiKey(): Promise<string | undefined> {
  const mod = piAgent as PiAuthModule & typeof piAgent;

  // pi >= 0.80.8: readStoredCredential (AuthStorage removed)
  if (typeof mod.readStoredCredential === "function") {
    try {
      const cred = mod.readStoredCredential("ollama-cloud");
      if (cred && cred.type === "api_key" && cred.key) return cred.key;
    } catch (e) {
      console.debug("ollama-cloud: readStoredCredential probe failed:", e);
    }
  }

  // pi <= 0.80.7: AuthStorage still exported
  if (mod.AuthStorage) {
    try {
      const authStorage = mod.AuthStorage.create();
      // getApiKey is async (resolves env vars, $VAR, !command, OAuth refresh).
      const key = await authStorage.getApiKey("ollama-cloud");
      if (key) return key;
    } catch (e) {
      console.debug("ollama-cloud: AuthStorage probe failed:", e);
    }
  }

  // pi-ai doesn't know the "ollama-cloud" provider id, so neither auth path
  // sees OLLAMA_API_KEY — keep the explicit env fallback for both. (#24/#48)
  return process.env.OLLAMA_API_KEY;
}

function noApiKeyError() {
  return {
    content: [
      {
        type: "text" as const,
        text: "Error: No Ollama Cloud API key configured. Set OLLAMA_API_KEY or add to auth.json.",
      },
    ],
    isError: true,
  };
}

const PREVIEW_LINES = 8;

/**
 * Build a renderResult handler that shows a truncated preview when collapsed
 * and the full output when expanded. Follows the bash tool pattern.
 */
function createRenderResult() {
  return (
    result: { content: Array<{ type: string; text: string }>; isError?: boolean },
    options: { expanded: boolean; isPartial: boolean },
    theme: import("@earendil-works/pi-coding-agent").Theme,
    context: {
      invalidate: () => void;
      lastComponent: import("@earendil-works/pi-tui").Component | undefined;
      state: { cachedWidth?: number; cachedLines?: string[]; cachedSkipped?: number };
    },
  ) => {
    const state = context.state;
    const output = result.content
      .map((c) => c.text)
      .join("")
      .trim();
    const styledOutput = output
      .split("\n")
      .map((line: string) => theme.fg("toolOutput", line))
      .join("\n");

    if (options.expanded || result.isError) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(result.isError ? styledOutput : `\n${styledOutput}`);
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
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const apiKey = await getCloudApiKey();
      if (!apiKey) return noApiKeyError();

      try {
        const res = await fetch(`${OLLAMA_BASE}/api/web_search`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: params.query,
            max_results: params.max_results ?? 5,
          }),
          signal,
        });

        if (!res.ok) {
          const errorText = await res.text().catch(() => "");
          if (res.status === 401 || res.status === 403) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    "Ollama Cloud search failed: authentication error. " +
                    "Check your API key in OLLAMA_API_KEY or auth.json.",
                },
              ],
              isError: true,
            };
          }
          if (res.status === 429) {
            return {
              content: [{ type: "text", text: "Ollama Cloud search failed: rate limited. Try again shortly." }],
              isError: true,
            };
          }
          return {
            content: [
              { type: "text", text: `Search API error (status ${res.status}): ${errorText || res.statusText}` },
            ],
            isError: true,
          };
        }

        const data = (await res.json()) as SearchResponse;
        const formatted = data.results
          .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.content}`)
          .join("\n\n");

        return {
          content: [{ type: "text", text: formatted || "No results found." }],
          details: { results: data.results },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Web search failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
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
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const apiKey = await getCloudApiKey();
      if (!apiKey) return noApiKeyError();

      try {
        const res = await fetch(`${OLLAMA_BASE}/api/web_fetch`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url: params.url }),
          signal,
        });

        if (!res.ok) {
          const errorText = await res.text().catch(() => "");
          if (res.status === 401 || res.status === 403) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    "Ollama Cloud fetch failed: authentication error. " +
                    "Check your API key in OLLAMA_API_KEY or auth.json.",
                },
              ],
              isError: true,
            };
          }
          if (res.status === 429) {
            return {
              content: [{ type: "text", text: "Ollama Cloud fetch failed: rate limited. Try again shortly." }],
              isError: true,
            };
          }
          return {
            content: [{ type: "text", text: `Fetch API error (status ${res.status}): ${errorText || res.statusText}` }],
            isError: true,
          };
        }

        const data = (await res.json()) as FetchResponse;
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
      } catch (err) {
        return {
          content: [{ type: "text", text: `Web fetch failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
    renderCall(args, theme, _context) {
      const display = args.url ? `ollama_web_fetch("${args.url}")` : "ollama_web_fetch";
      return new Text(theme.fg("toolTitle", display), 0, 0);
    },
    renderResult: createRenderResult(),
  });
}
