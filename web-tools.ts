import {
  type ExtensionAPI,
  type ExtensionContext,
  keyHint,
  truncateToVisualLines,
} from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
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

async function getCloudApiKey(ctx: ExtensionContext): Promise<string | undefined> {
  return ctx.modelRegistry.getApiKeyForProvider("ollama-cloud");
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
    theme: import("@mariozechner/pi-coding-agent").Theme,
    context: {
      invalidate: () => void;
      lastComponent: import("@mariozechner/pi-tui").Component | undefined;
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
        Type.Number({ description: "Maximum number of search results to return (default: 5, max: 10)", default: 5 }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const apiKey = await getCloudApiKey(ctx);
      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No Ollama Cloud API key configured. Set OLLAMA_API_KEY or add to auth.json.",
            },
          ],
          isError: true,
        };
      }

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
      url: Type.String({ description: "URL to fetch and extract content from" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const apiKey = await getCloudApiKey(ctx);
      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No Ollama Cloud API key configured. Set OLLAMA_API_KEY or add to auth.json.",
            },
          ],
          isError: true,
        };
      }

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
    renderResult: createRenderResult(),
  });
}
