import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getModels, getProviders } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  type ExtensionCommandContext,
  getAgentDir,
  type ProviderModelConfig,
} from "@mariozechner/pi-coding-agent";

// --- Constants ---
const CACHE_DIR = join(getAgentDir(), "cache");
const CACHE_FILE = join(CACHE_DIR, "ollama-cloud-models.json");
const FETCH_TIMEOUT_MS = 10000;

// --- API fetch ---
export const OLLAMA_BASE = (process.env.OLLAMA_API_BASE || "https://ollama.com").replace(/\/+$/, "");

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

// --- Built-in model knowledge index ---
// Build a lookup of model ID -> thinkingLevelMap from pi's built-in models.
// This avoids hardcoding model-family mappings: when pi-mono updates its
// model definitions (e.g. DeepSeek V4's thinking levels), the extension
// picks up the changes automatically.
const BUILTIN_THINKING_MAP: Record<string, ProviderModelConfig["thinkingLevelMap"]> = {};
// Fallback: family stem -> [stem, thinkingLevelMap] pairs for models whose Ollama Cloud
// ID doesn't match exactly.  The stem is derived by stripping provider prefixes and
// non-alphanumeric characters (e.g. "gemma-4-31b-it" -> "gemma431bit").
// When looking up an Ollama model by its details.family field, we search for a pi stem
// that starts with the family stem (e.g. family "gemma4" -> pi "gemma431bit").
// Entries are sorted longest-first so the most specific match wins.
const BUILTIN_FAMILY_ENTRIES: [string, NonNullable<ProviderModelConfig["thinkingLevelMap"]>][] = [];
for (const provider of getProviders()) {
  for (const model of getModels(provider as any)) {
    if (model.thinkingLevelMap) {
      BUILTIN_THINKING_MAP[model.id] = model.thinkingLevelMap;
      const stem = model.id
        .replace(/^[a-z0-9-]+\//, "") // strip provider prefix (e.g. "zai/", "deepseek/")
        .replace(/[^a-zA-Z0-9]/g, "") // strip non-alphanumeric
        .toLowerCase();
      BUILTIN_FAMILY_ENTRIES.push([stem, model.thinkingLevelMap]);
    }
  }
}
// Longest stems first so a more specific match (e.g. "gemma431bit") wins over a generic one (e.g. "gemma4").
BUILTIN_FAMILY_ENTRIES.sort((a, b) => b[0].length - a[0].length);

function resolveThinkingLevelMap(modelId: string, data: OllamaShowResponse): ProviderModelConfig["thinkingLevelMap"] {
  // 1. Exact ID match (e.g. "deepseek-v4-pro")
  const exact = BUILTIN_THINKING_MAP[modelId];
  if (exact) return exact;

  // 2. Family-based fallback: match Ollama's details.family against pi model stems
  if (data.capabilities?.includes("thinking")) {
    const familyStem = data.details?.family?.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() ?? "";
    if (familyStem) {
      for (const [stem, tlm] of BUILTIN_FAMILY_ENTRIES) {
        if (stem.startsWith(familyStem)) {
          return tlm;
        }
      }
    }
  }

  return undefined;
}

export function assembleModels(raw: Record<string, OllamaShowResponse>): ProviderModelConfig[] {
  return Object.entries(raw)
    .filter(([, data]) => data.capabilities?.includes("tools"))
    .map(([id, data]) => ({
      id,
      name: id,
      reasoning: data.capabilities?.includes("thinking") ?? false,
      thinkingLevelMap: resolveThinkingLevelMap(id, data),
      input: (data.capabilities?.includes("vision") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: getContextLength(data.model_info ?? {}),
      maxTokens: 32768,
      compat: { supportsDeveloperRole: false },
    }));
}

// --- Fallback models (cold cache) ---
export const FALLBACK_MODELS: ProviderModelConfig[] = [
  {
    id: "glm-5.1",
    name: "GLM 5.1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 202752,
    maxTokens: 32768,
    compat: { supportsDeveloperRole: false },
  },
  {
    id: "gemma4:31b",
    name: "Gemma 4 31B",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 32768,
    compat: { supportsDeveloperRole: false },
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
  const apiKey = (await authStorage.getApiKey("ollama-cloud")) ?? process.env.OLLAMA_API_KEY;

  if (!apiKey) {
    ctx.ui.notify(
      "No Ollama Cloud API key found. \n" +
        "Please ensure your API key is set in: \n" +
        "- auth.json file (at ~/.pi/agent/auth.json) under 'ollama-cloud' key,\n" +
        "- or via the CLI --api-key flag.\n" +
        "Example auth.json entry: \n" +
        '{ "ollama-cloud": { "type": "api_key", "key": "YOUR_API_KEY" } }',
      "error",
    );
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
