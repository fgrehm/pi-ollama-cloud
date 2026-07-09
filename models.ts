import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionCommandContext, getAgentDir, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { resolve as resolveThinkingLevelMap } from "./thinking-levels.ts";
import { concurrentMap, fetchJsonWithTimeout, getContextLength } from "./utils.ts";

// --- Constants ---
const CACHE_DIR = join(getAgentDir(), "cache");
const CACHE_FILE = join(CACHE_DIR, "ollama-cloud-models.json");
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;

// The cloud extension always targets ollama.com; local Ollama daemons (typically
// pointed at via OLLAMA_API_BASE for the local CLI) are a different product and
// must not silently redirect cloud requests. Warn once at module load if the
// env var looks like a non-cloud target so the misconfiguration is visible.
const CLOUD_BASE_URL = "https://ollama.com";
const envBase = typeof process !== "undefined" ? process.env?.OLLAMA_API_BASE : undefined;
if (envBase && !/^https:\/\/ollama\.com\b/i.test(envBase)) {
  // eslint-disable-next-line no-console
  console.warn(
    `[pi-ollama-cloud] Ignoring OLLAMA_API_BASE=${envBase}; ` +
      `this extension always targets ${CLOUD_BASE_URL}. ` +
      `Unset OLLAMA_API_BASE (or set it to the cloud URL) to silence this warning.`,
  );
}
export const OLLAMA_BASE = CLOUD_BASE_URL.replace(/\/+$/, "");

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

/**
 * Build an explicit OpenAICompletionsCompat for an Ollama Cloud model.
 * Every flag is set explicitly so the contract is visible to maintainers.
 *
 * Ollama API reference: https://docs.ollama.com/api/openai-compatibility
 * pi type definition: https://github.com/earendil-works/pi/blob/b94482762321ed0b9f8f245be57c84d786a7105d/packages/ai/src/types.ts#L361-L400
 * pi compat resolution:  https://docs.ollama.com/api/openai-compatibility https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/types.ts#L365-L425
 */
function buildCompat(): ProviderModelConfig["compat"] {
  return {
    // Ollama uses "system" role, not "developer" (ollama: docs.ollama.com/api/openai-compatibility, pi: types.ts#supportsDeveloperRole).
    supportsDeveloperRole: false,
    // reasoning_effort works (ollama: docs.ollama.com/api/openai-compatibility, pi: types.ts#supportsReasoningEffort, tested in think-experiment.md).
    supportsReasoningEffort: true,
    // "store" is not a supported field (ollama: docs.ollama.com/api/openai-compatibility, pi: types.ts#supportsStore).
    supportsStore: false,
    // Ollama lists "max_tokens", not "max_completion_tokens" (ollama: docs.ollama.com/api/openai-compatibility, pi: types.ts#maxTokensField).
    maxTokensField: "max_tokens",
    // stream_options.include_usage is supported (ollama: docs.ollama.com/api/openai-compatibility, pi: types.ts#supportsUsageInStreaming).
    supportsUsageInStreaming: true,
    // Default: tool results don't need a name field (pi: types.ts#requiresToolResultName).
    requiresToolResultName: false,
    // Default: no assistant message required between tool result and user (pi: types.ts#requiresAssistantAfterToolResult).
    requiresAssistantAfterToolResult: false,
    // Ollama supports native thinking blocks (pi: types.ts#requiresThinkingAsText).
    requiresThinkingAsText: false,
    // DeepSeek-specific, not needed for Ollama (pi: types.ts#requiresReasoningContentOnAssistantMessages).
    requiresReasoningContentOnAssistantMessages: false,
    // reasoning_effort format works (pi: types.ts#thinkingFormat, tested in think-experiment.md).
    thinkingFormat: "openai",
    // Ollama does not support tool_choice, so strict mode is unavailable (ollama: docs.ollama.com/api/openai-compatibility, pi: types.ts#supportsStrictMode).
    supportsStrictMode: false,
    // Anthropic cache_control not relevant; Ollama has implicit KV cache only (pi: types.ts#cacheControlFormat).
    // Explicitly undefined: JSON.stringify drops undefined values, keeping
    // models.generated.ts structurally consistent with assembleModels() runtime output.
    // Session affinity headers not relevant for Ollama (pi: types.ts#sendSessionAffinityHeaders).
    sendSessionAffinityHeaders: false,
    // No explicit cache-retention API (pi: types.ts#supportsLongCacheRetention).
    supportsLongCacheRetention: false,
    // Not z.ai (pi: types.ts#zaiToolStream).
    zaiToolStream: false,
    cacheControlFormat: undefined,
    openRouterRouting: {},
    vercelGatewayRouting: {},
  };
}

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
      // No per-model limit exposed by the API (https://docs.ollama.com/api-reference/show-model-details,
      // https://github.com/ollama/ollama/issues/7222). 32768 matches most Ollama Cloud context windows.
      maxTokens: 32768,
      compat: buildCompat(),
    }));
}

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
export async function fetchModelIds(timeoutMs = FETCH_TIMEOUT_MS): Promise<string[]> {
  const headers: Record<string, string> = {};
  const apiKey = process.env.OLLAMA_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetchJsonWithTimeout<{ data: { id: string }[] }>(
    `${OLLAMA_BASE}/v1/models`,
    { headers },
    timeoutMs,
  );

  if (res.status === 429) {
    throw new Error("Ollama Cloud rate limited. Try again shortly.");
  }
  if (!res.ok || !res.data) {
    throw new Error(`Failed to fetch model list: ${res.status}${res.error ? ` - ${res.error}` : ""}`);
  }

  return res.data.data.map((m) => m.id);
}

export async function fetchModelDetails(id: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<CachedOllamaModel> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = process.env.OLLAMA_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetchJsonWithTimeout<OllamaShowResponse>(
    `${OLLAMA_BASE}/api/show`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ model: id }),
    },
    timeoutMs,
  );

  if (res.status === 429) {
    throw new Error("Ollama Cloud rate limited. Try again shortly.");
  }
  if (!res.ok || !res.data) {
    throw new Error(`Failed to fetch /api/show for ${id}: ${res.status}${res.error ? ` - ${res.error}` : ""}`);
  }

  return res.data;
}

export async function refreshOllamaCloudModels(params: {
  notify?: (message: string, level?: "info" | "error") => void;
  onProgress?: (progress: RefreshProgress) => void;
  workers?: number;
}): Promise<Record<string, CachedOllamaModel>> {
  const notify = params.notify ?? (() => undefined);
  const onProgress = params.onProgress ?? (() => undefined);
  onProgress({ stage: "list", message: "Fetching model list..." });
  const modelIds = await fetchModelIds();
  notify(`Found ${modelIds.length} models, fetching details...`);
  onProgress({ stage: "details", current: 0, total: modelIds.length, failed: 0, message: "Fetching model details" });

  let detailsDone = 0;
  let detailsFailed = 0;
  const detailResults = await concurrentMap(modelIds, params.workers ?? 8, async (id) => {
    try {
      return [id, await fetchModelDetails(id)] as const;
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

export async function fetchModels(
  ctx: Pick<ExtensionCommandContext, "ui">,
  onProgress?: (progress: RefreshProgress) => void,
): Promise<Record<string, CachedOllamaModel> | null> {
  try {
    return await refreshOllamaCloudModels({
      notify: (message, level) => ctx.ui.notify(message, level),
      onProgress,
    });
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return null;
  }
}
