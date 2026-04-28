/**
 * Ollama Cloud Provider Extension
 *
 * Registers Ollama Cloud as a model provider with dynamically fetched models.
 *
 * Setup:
 *   1. Get an API key from https://ollama.com
 *   2. Add to auth.json in the agent config dir (~/.pi/agent/auth.json, or set PI_CODING_AGENT_DIR):
 *      { "ollama-cloud": { "type": "api_key", "key": "your-key" } }
 *   3. Run /ollama-cloud-refresh to fetch models (uses cache or fallback on boot)
 *   4. Use /model or ctrl+l to select an Ollama Cloud model
 *
 * Two endpoints are used to build the model list:
 *   - GET  https://ollama.com/v1/models  -> list of model IDs
 *   - POST https://ollama.com/api/show   -> per-model details (capabilities, context length)
 *
 * Raw /api/show responses are cached at <agentDir>/cache/ollama-cloud-models.json
 * so the provider assembly can be debugged and re-derived without re-fetching.
 *
 * Cache never expires -- run /ollama-cloud-refresh to update.
 * Cold cache falls back to a small set of hardcoded models.
 *
 * Only models with "tools" capability are registered.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  keyHint,
  type ProviderModelConfig,
  truncateToVisualLines,
} from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const CACHE_DIR = join(getAgentDir(), "cache");
const CACHE_FILE = join(CACHE_DIR, "ollama-cloud-models.json");
const FETCH_TIMEOUT_MS = 10000;

/**
 * Base URL for the Ollama Cloud API.
 * Defaults to "https://ollama.com"; override with OLLAMA_API_BASE to point at a proxy or self-hosted instance.
 */
const OLLAMA_BASE = process.env.OLLAMA_API_BASE || "https://ollama.com";

/**
 * Opt-out flag for the ollama_web_search and ollama_web_fetch tools.
 * When the value is one of "0", "false", "no", "off", or the empty string,
 * both web tool registrations are skipped. The model provider and
 * /ollama-cloud-refresh command remain active regardless.
 */
const PI_OWT_RAW = process.env.PI_OLLAMA_WEB_TOOLS;
const WEB_TOOLS_DISABLED = PI_OWT_RAW !== undefined && ["0", "false", "no", "off", ""].includes(PI_OWT_RAW);

// --- Raw API types ---

/** Response from POST /api/show */
interface OllamaShowResponse {
  details: {
    parent_model: string;
    format: string;
    family: string;
    families: string[] | null;
    parameter_size: string;
    quantization_level: string;
  };
  model_info: Record<string, unknown>;
  capabilities: string[];
  modified_at: string;
}

/** On-disk cache: raw /api/show responses keyed by model ID */
interface CachedData {
  timestamp: number;
  models: Record<string, OllamaShowResponse>;
}

// --- Assembly: raw API data -> ProviderModelConfig[] ---

function getContextLength(modelInfo: Record<string, unknown>): number {
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(".context_length") && typeof value === "number") {
      return value;
    }
  }
  return 128000;
}

function assembleModels(raw: Record<string, OllamaShowResponse>): ProviderModelConfig[] {
  return Object.entries(raw)
    .filter(([, data]) => data.capabilities?.includes("tools"))
    .map(([id, data]) => ({
      id,
      name: id,
      reasoning: data.capabilities?.includes("thinking") ?? false,
      input: (data.capabilities?.includes("vision") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: getContextLength(data.model_info ?? {}),
      maxTokens: 32768,
    }));
}

// --- Fallback models (cold cache) ---

const FALLBACK_MODELS: ProviderModelConfig[] = [
  {
    id: "glm-5.1:cloud",
    name: "GLM 5.1 Cloud",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 202752,
    maxTokens: 32768,
  },
  {
    id: "gemma4:cloud",
    name: "Gemma 4 Cloud",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 32768,
  },
];

// --- Cache I/O ---

function readCache(): Record<string, OllamaShowResponse> | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const data: CachedData = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    if (!data.models || Object.keys(data.models).length === 0) return null;
    return data.models;
  } catch {
    return null;
  }
}

function writeCache(models: Record<string, OllamaShowResponse>): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ timestamp: Date.now(), models } satisfies CachedData, null, 2));
  } catch {
    // Ignore cache write errors
  }
}

// --- API fetch ---

async function fetchModels(ctx: ExtensionCommandContext): Promise<Record<string, OllamaShowResponse>> {
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider("ollama-cloud");
  if (!apiKey) {
    ctx.ui.notify("No Ollama Cloud API key configured (auth.json or OLLAMA_API_KEY env var)", "error");
    return {};
  }

  // 1. Fetch model list from /v1/models
  const listController = new AbortController();
  const listTimeout = setTimeout(() => listController.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: listController.signal,
    });
    if (!res.ok) {
      ctx.ui.notify(`Failed to fetch model list: ${res.status}`, "error");
      return {};
    }
    const data = (await res.json()) as { data: { id: string }[] };
    const modelIds = data.data.map((m) => m.id);
    ctx.ui.notify(`Found ${modelIds.length} models, fetching details...`);
    clearTimeout(listTimeout);

    // 2. Fetch /api/show for each model in parallel
    const results: Record<string, OllamaShowResponse> = {};
    const settled = await Promise.allSettled(
      modelIds.map(async (id) => {
        const showController = new AbortController();
        const showTimeout = setTimeout(() => showController.abort(), FETCH_TIMEOUT_MS);
        try {
          const res = await fetch(`${OLLAMA_BASE}/api/show`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ model: id }),
            signal: showController.signal,
          });
          if (!res.ok) return;
          const showData = (await res.json()) as OllamaShowResponse;
          results[id] = showData;
        } finally {
          clearTimeout(showTimeout);
        }
      }),
    );

    const succeeded = settled.filter((r) => r.status === "fulfilled").length;
    const failed = settled.length - succeeded;
    ctx.ui.notify(`Fetched ${Object.keys(results).length} model details${failed ? ` (${failed} failed)` : ""}`, "info");

    return results;
  } catch {
    ctx.ui.notify("Failed to fetch Ollama Cloud models", "error");
    return {};
  }
}

// --- Web search/fetch types ---

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

async function getCloudApiKey(ctx: ExtensionContext): Promise<string | undefined> {
  return ctx.modelRegistry.getApiKeyForProvider("ollama-cloud");
}

// --- Tool rendering helpers ---

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

function registerProvider(pi: ExtensionAPI, models: ProviderModelConfig[]) {
  pi.registerProvider("ollama-cloud", {
    baseUrl: `${OLLAMA_BASE}/v1`,
    apiKey: "OLLAMA_API_KEY",
    api: "openai-completions",
    models,
  });
}

function registerRefreshCommand(pi: ExtensionAPI) {
  pi.registerCommand("ollama-cloud-refresh", {
    description: "Refresh Ollama Cloud models from the API",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.setWorkingMessage("Refreshing Ollama Cloud models...");

      const raw = await fetchModels(ctx);
      if (Object.keys(raw).length === 0) {
        ctx.ui.notify("No models fetched -- keeping existing models", "warning");
        ctx.ui.setWorkingMessage();
        return;
      }

      writeCache(raw);
      const newModels = assembleModels(raw);

      // NOTE: Some models may trigger errors like:
      //   Error: 400 "developer is not one of ['system', 'assistant', 'user', 'tool', 'function']"
      // If that comes up, consider setting `supportsDeveloperRole: false` in the compat field
      // for the provider or specific models, e.g.:
      //   compat: { supportsDeveloperRole: false }
      registerProvider(pi, newModels);

      ctx.ui.notify(`Registered ${newModels.length} Ollama Cloud models`, "info");
      ctx.ui.setWorkingMessage();
    },
  });
}

function registerWebSearchTool(pi: ExtensionAPI) {
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

function registerWebFetchTool(pi: ExtensionAPI) {
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

// --- Main ---

export default async function (pi: ExtensionAPI) {
  const cached = readCache();
  const models = cached ? assembleModels(cached) : FALLBACK_MODELS;

  registerProvider(pi, models);
  registerRefreshCommand(pi);

  if (!WEB_TOOLS_DISABLED) {
    registerWebSearchTool(pi);
    registerWebFetchTool(pi);
  }
}
