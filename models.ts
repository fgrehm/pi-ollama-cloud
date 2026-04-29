import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionCommandContext, getAgentDir, type ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { AuthStorage } from "@mariozechner/pi-coding-agent";

// --- Constants ---
const CACHE_DIR = join(getAgentDir(), "cache");
const CACHE_FILE = join(CACHE_DIR, "ollama-cloud-models.json");
const FETCH_TIMEOUT_MS = 10000;

// --- API fetch ---
export let OLLAMA_BASE = (process.env.OLLAMA_API_BASE || "https://ollama.com").replace(/\/+$/, "");

// Initialize AuthStorage
const authStorage = AuthStorage.create();

// --- Raw API types ---
/** Response from POST /api/show */
export interface OllamaShowResponse {
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

export function assembleModels(raw: Record<string, OllamaShowResponse>): ProviderModelConfig[] {
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
export const FALLBACK_MODELS: ProviderModelConfig[] = [
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
export function readCache(): Record<string, OllamaShowResponse> | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const data: CachedData = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    if (!data.models || Object.keys(data.models).length === 0) return null;
    return data.models;
  } catch {
    return null;
  }
}

export function writeCache(models: Record<string, OllamaShowResponse>): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ timestamp: Date.now(), models } satisfies CachedData, null, 2));
  } catch {
    // Ignore cache write errors
  }
}

// --- Fetch Models ---
export async function fetchModels(ctx: ExtensionCommandContext): Promise<Record<string, OllamaShowResponse> | null> {
  const apiKey = await authStorage.getApiKey("ollama-cloud");
  
  if (!apiKey) {
    ctx.ui.notify(
      "No Ollama Cloud API key found. \n" +
      "Please ensure your API key is set in: \n" +
      "- auth.json file (at ~/.pi/agent/auth.json) under 'ollama-cloud' key,\n" +
      "- or via the CLI --api-key flag.\n" +
      "Example auth.json entry: \n" +
      '{ \"ollama-cloud\": { \"type\": \"api_key\", \"key\": \"YOUR_API_KEY\" } }'
    , "error");
    return null;
  }

  // 1. Fetch model list from /v1/models
  let modelIds: string[];
  const listController = new AbortController();
  const listTimeout = setTimeout(() => listController.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: listController.signal,
    });
    if (!res.ok) {
      ctx.ui.notify(`Failed to fetch model list: ${res.status}`, "error");
      return null;
    }
    const data = (await res.json()) as { data: { id: string }[] };
    modelIds = data.data.map((m) => m.id);
    ctx.ui.notify(`Found ${modelIds.length} models, fetching details...`);
  } catch {
    ctx.ui.notify("Failed to fetch Ollama Cloud models", "error");
    return null;
  } finally {
    clearTimeout(listTimeout);
  }

  // 2. Fetch /api/show for each model in parallel
  const results: Record<string, OllamaShowResponse> = {};
  await Promise.allSettled(
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
        if (!res.ok) throw new Error(`status ${res.status}`);
        const showData = (await res.json()) as OllamaShowResponse;
        results[id] = showData;
      } finally {
        clearTimeout(showTimeout);
      }
    }),
  );

  const succeeded = Object.keys(results).length;
  const failed = modelIds.length - succeeded;
  if (succeeded === 0) {
    ctx.ui.notify(`Failed to fetch model details${failed ? ` (${failed} failed)` : ""}`, "error");
    return null;
  }
  ctx.ui.notify(`Fetched ${succeeded} model details${failed ? ` (${failed} failed)` : ""}`, "info");

  return results;
}