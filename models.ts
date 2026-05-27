import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuthStorage,
  type ExtensionCommandContext,
  getAgentDir,
  type ProviderModelConfig,
} from "@mariozechner/pi-coding-agent";
import { resolve as resolveThinkingLevelMap } from "./thinking-levels.ts";
import { concurrentMap, fetchJsonWithTimeout, getContextLength } from "./utils.ts";

// --- Constants ---
const CACHE_DIR = join(getAgentDir(), "cache");
const CACHE_FILE = join(CACHE_DIR, "ollama-cloud-models.json");
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;

export const OLLAMA_BASE = (process.env.OLLAMA_API_BASE || "https://ollama.com").replace(/\/+$/, "");

// Initialize AuthStorage
const authStorage = AuthStorage.create();

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

type CachedOllamaModel = OllamaShowResponse;

/** On-disk cache: raw /api/show responses keyed by model ID. */
interface CachedData {
  /** Unix epoch milliseconds used to decide when the generated metadata is stale. */
  timestamp?: number;
  models: Record<string, CachedOllamaModel>;
}

type RefreshProgressStage = "list" | "details" | "done";

export interface RefreshProgress {
  stage: RefreshProgressStage;
  current?: number;
  total?: number;
  failed?: number;
  message: string;
}

// --- Assembly: raw API data -> ProviderModelConfig[] ---
export function assembleModels(raw: Record<string, CachedOllamaModel>): ProviderModelConfig[] {
  return Object.entries(raw)
    .filter(([, data]) => data.capabilities?.includes("tools"))
    .map(([id, data]) => ({
      id,
      name: id,
      reasoning: data.capabilities?.includes("thinking") ?? false,
      thinkingLevelMap: resolveThinkingLevelMap(id, data.capabilities ?? []),
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
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 202752,
    maxTokens: 32768,
    compat: { supportsDeveloperRole: false },
  },
  {
    id: "gemma4:31b",
    name: "Gemma 4 31B",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 32768,
    compat: { supportsDeveloperRole: false },
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 32768,
    compat: { supportsDeveloperRole: false },
  },
  {
    id: "qwen3.5",
    name: "Qwen 3.5",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 32768,
    compat: { supportsDeveloperRole: false },
  },
  {
    id: "kimi-k2.6",
    name: "Kimi K2.6",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 32768,
    compat: { supportsDeveloperRole: false },
  },
];

// --- Cache I/O ---
type CacheState =
  | { status: "fresh"; models: Record<string, CachedOllamaModel> }
  | { status: "stale"; models: Record<string, CachedOllamaModel> }
  | { status: "missing" };

function createCacheData(models: Record<string, CachedOllamaModel>, now = new Date()): CachedData {
  return { timestamp: now.getTime(), models };
}

function readCacheData(path: string): CachedData | null {
  try {
    const data: CachedData = JSON.parse(readFileSync(path, "utf-8"));
    if (!data.models || Object.keys(data.models).length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

function isFreshGeneratedCache(data: CachedData): boolean {
  if (typeof data.timestamp !== "number" || !Number.isFinite(data.timestamp)) return false;
  return Date.now() - data.timestamp <= CACHE_MAX_AGE_MS;
}

export function readCacheState(): CacheState {
  if (!existsSync(CACHE_FILE)) return { status: "missing" };

  const data = readCacheData(CACHE_FILE);
  if (!data) {
    try {
      rmSync(CACHE_FILE, { force: true });
    } catch {
      // Ignore cache delete errors.
    }
    return { status: "missing" };
  }

  return isFreshGeneratedCache(data)
    ? { status: "fresh", models: data.models }
    : { status: "stale", models: data.models };
}

export function writeCache(models: Record<string, CachedOllamaModel>): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(createCacheData(models), null, 2));
  } catch {
    // Ignore cache write errors
  }
}

// --- Fetch Models ---
async function fetchModelIds(apiKey: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string[]> {
  const res = await fetchJsonWithTimeout<{ data: { id: string }[] }>(
    `${OLLAMA_BASE}/v1/models`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    timeoutMs,
  );
  if (!res.ok || !res.data)
    throw new Error(`Failed to fetch model list: ${res.status}${res.error ? ` - ${res.error}` : ""}`);
  return res.data.data.map((m) => m.id);
}

async function fetchModelDetails(apiKey: string, id: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<CachedOllamaModel> {
  const res = await fetchJsonWithTimeout<OllamaShowResponse>(
    `${OLLAMA_BASE}/api/show`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: id }),
    },
    timeoutMs,
  );
  if (!res.ok || !res.data)
    throw new Error(`Failed to fetch /api/show for ${id}: ${res.status}${res.error ? ` - ${res.error}` : ""}`);
  return res.data;
}

async function refreshOllamaCloudModels(params: {
  apiKey: string;
  notify?: (message: string, level?: "info" | "error") => void;
  onProgress?: (progress: RefreshProgress) => void;
  workers?: number;
}): Promise<Record<string, CachedOllamaModel>> {
  const notify = params.notify ?? (() => undefined);
  const onProgress = params.onProgress ?? (() => undefined);
  onProgress({ stage: "list", message: "Fetching model list..." });
  const modelIds = await fetchModelIds(params.apiKey);
  notify(`Found ${modelIds.length} models, fetching details...`);
  onProgress({ stage: "details", current: 0, total: modelIds.length, failed: 0, message: "Fetching model details" });

  let detailsDone = 0;
  let detailsFailed = 0;
  const detailResults = await concurrentMap(modelIds, params.workers ?? 8, async (id) => {
    try {
      return [id, await fetchModelDetails(params.apiKey, id)] as const;
    } catch (error) {
      detailsFailed++;
      throw error;
    } finally {
      detailsDone++;
      onProgress({
        stage: "details",
        current: detailsDone,
        total: modelIds.length,
        failed: detailsFailed,
        message: "Fetching model details",
      });
    }
  });
  const models: Record<string, CachedOllamaModel> = {};
  for (const result of detailResults) {
    if (result.status === "fulfilled") {
      const [id, data] = result.value;
      models[id] = data;
    }
  }
  const succeeded = Object.keys(models).length;
  if (succeeded === 0)
    throw new Error(`Failed to fetch model details${detailsFailed ? ` (${detailsFailed} failed)` : ""}`);
  notify(`Fetched ${succeeded} model details${detailsFailed ? ` (${detailsFailed} failed)` : ""}`, "info");

  onProgress({
    stage: "done",
    current: Object.keys(models).length,
    total: Object.keys(models).length,
    message: "Done",
  });
  return models;
}

async function getOllamaCloudApiKey(): Promise<string | undefined> {
  return (await authStorage.getApiKey("ollama-cloud")) ?? process.env.OLLAMA_API_KEY;
}

async function refreshModelsFromAuth(
  params: {
    notify?: (message: string, level?: "info" | "error") => void;
    onProgress?: (progress: RefreshProgress) => void;
  } = {},
): Promise<Record<string, CachedOllamaModel> | null> {
  const apiKey = await getOllamaCloudApiKey();
  if (!apiKey) return null;

  return refreshOllamaCloudModels({
    apiKey,
    notify: params.notify,
    onProgress: params.onProgress,
  });
}

// --- Model Fallback Aliases ---
/**
 * Maps model IDs that don't exist on Ollama Cloud to their closest available equivalents.
 * Aliases are transparent: the model appears in the selector with the alias name, but API
 * requests are remapped to the real backend model via the `before_provider_request` hook.
 */
export const FALLBACK_ALIASES: Record<string, string | string[]> = {
  "qwen3.6-plus": ["qwen3.5:397b", "qwen3.5"],
};

/**
 * Expands a model list with fallback aliases. Each alias copies all properties
 * from its target model. If the target model isn't in the assembled list, the
 * alias is silently skipped (e.g. during cold cache before refresh completes).
 */
export function addFallbackModels(models: ProviderModelConfig[]): ProviderModelConfig[] {
  const existingIds = new Set(models.map((m) => m.id));
  const aliases: ProviderModelConfig[] = [];
  for (const [aliasId, targetId] of Object.entries(FALLBACK_ALIASES)) {
    if (existingIds.has(aliasId)) continue;
    const targetIds = Array.isArray(FALLBACK_ALIASES[aliasId])
      ? FALLBACK_ALIASES[aliasId]
      : [FALLBACK_ALIASES[aliasId]];
    let target = undefined;
    for (const targetId of (targetIds as string[])) {
      target = models.find((m) => m.id === targetId);
      if (target) break;
    }
    if (!target) continue;
    aliases.push({
      ...target,
      id: aliasId,
      name: aliasId,
    });
  }
  return aliases.length > 0 ? [...models, ...aliases] : models;
}

export async function fetchModels(
  ctx: Pick<ExtensionCommandContext, "ui">,
  onProgress?: (progress: RefreshProgress) => void,
): Promise<Record<string, CachedOllamaModel> | null> {
  try {
    const result = await refreshModelsFromAuth({
      notify: (message, level) => ctx.ui.notify(message, level),
      onProgress,
    });
    if (!result) {
      ctx.ui.notify(
        "No Ollama Cloud API key found. \n" +
          "Please ensure your API key is set in either: \n" +
          "- OLLAMA_API_KEY environment variable,\n" +
          "- auth.json file (at ~/.pi/agent/auth.json) under 'ollama-cloud' key,\n" +
          "- or via the CLI --api-key flag.\n" +
          "Example auth.json entry: \n" +
          '{ "ollama-cloud": { "type": "api_key", "key": "YOUR_API_KEY" } }',
        "error",
      );
    }
    return result;
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return null;
  }
}
