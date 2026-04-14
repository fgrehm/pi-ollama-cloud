/**
 * Ollama Cloud Provider Extension
 *
 * Registers Ollama Cloud as a model provider with dynamically fetched models.
 *
 * Setup:
 *   1. Get an API key from https://ollama.com
 *   2. Add to ~/.pi/agent/auth.json:
 *      { "ollama-cloud": { "type": "api_key", "key": "your-key" } }
 *   3. Run /ollama-cloud-refresh to fetch models (uses cache or fallback on boot)
 *   4. Use /model or ctrl+l to select an Ollama Cloud model
 *
 * Two endpoints are used to build the model list:
 *   - GET  https://ollama.com/v1/models  → list of model IDs
 *   - POST https://ollama.com/api/show   → per-model details (capabilities, context length)
 *
 * Raw /api/show responses are cached at ~/.pi/agent/cache/ollama-cloud-models.json
 * so the provider assembly can be debugged and re-derived without re-fetching.
 *
 * Cache never expires — run /ollama-cloud-refresh to update.
 * Cold cache falls back to a small set of hardcoded models.
 *
 * Only models with "tools" capability are registered.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ProviderModelConfig } from "@mariozechner/pi-coding-agent";

const CACHE_DIR = join(homedir(), ".pi", "agent", "cache");
const CACHE_FILE = join(CACHE_DIR, "ollama-cloud-models.json");
const FETCH_TIMEOUT_MS = 10000;

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

// --- Assembly: raw API data → ProviderModelConfig[] ---

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
    const res = await fetch("https://ollama.com/v1/models", {
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
          const res = await fetch("https://ollama.com/api/show", {
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

// --- Main ---

export default async function (pi: ExtensionAPI) {
  // Boot: assemble from cache or fall back
  const cached = readCache();
  const models = cached ? assembleModels(cached) : FALLBACK_MODELS;

  pi.registerProvider("ollama-cloud", {
    baseUrl: "https://ollama.com/v1",
    apiKey: "OLLAMA_API_KEY",
    api: "openai-completions",
    models,
  });

  // Slash command to refresh model list
  pi.registerCommand("ollama-cloud-refresh", {
    description: "Refresh Ollama Cloud models from the API",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.setWorkingMessage("Refreshing Ollama Cloud models...");

      const raw = await fetchModels(ctx);
      if (Object.keys(raw).length === 0) {
        ctx.ui.notify("No models fetched — keeping existing models", "warning");
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
      pi.registerProvider("ollama-cloud", {
        baseUrl: "https://ollama.com/v1",
        apiKey: "OLLAMA_API_KEY",
        api: "openai-completions",
        models: newModels,
      });

      ctx.ui.notify(`Registered ${newModels.length} Ollama Cloud models`, "info");
      ctx.ui.setWorkingMessage();
    },
  });
}
