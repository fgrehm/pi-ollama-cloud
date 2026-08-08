import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { GENERATED_MODELS } from "./models.generated.ts";
import { MODEL_PRICING, type ModelPrice } from "./pricing.generated.ts";
import { resolve as resolveThinkingLevelMap } from "./thinking-levels.ts";
import { concurrentMap, fetchJsonWithTimeout, getContextLength } from "./utils.ts";

// --- Pricing ---
// Estimated per-1M-token prices are generated from models.dev by
// scripts/generate-pricing.ts (see pricing.generated.ts, do not edit by hand).
// Ollama Cloud is subscription-billed; these are equivalent pay-as-you-go
// estimates so /cost shows comparable usage, not actual charges.

/** Resolve the estimated price for an Ollama Cloud model ID. Exact match only;
 *  unmapped models return zero. */
function resolvePrice(id: string): ModelPrice {
  return MODEL_PRICING[id] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

// --- Constants ---
const FETCH_TIMEOUT_MS = 10000;
// How long a stored catalog is considered fresh before the next network refresh
// (mirrors pi-mono's REMOTE_CATALOG_REFRESH_INTERVAL_MS in remote-catalog-provider.ts).
const REFRESH_COOLDOWN_MS = 4 * 60 * 60 * 1000;

// The cloud extension always targets ollama.com; local Ollama daemons (typically
// pointed at via OLLAMA_API_BASE for the local CLI) are a different product and
// must not silently redirect cloud requests. Warn once at module load if the
// env var looks like a non-cloud target so the misconfiguration is visible.
const CLOUD_BASE_URL = "https://ollama.com";
const envBase = typeof process !== "undefined" ? process.env?.OLLAMA_API_BASE : undefined;
if (envBase) {
  // Warn when OLLAMA_API_BASE is set to anything other than the cloud host.
  // Parse the URL so lookalikes (e.g. https://ollama.com.evil.com) are not
  // mistaken for the cloud base. OLLAMA_API_BASE is otherwise ignored: this
  // extension always targets CLOUD_BASE_URL.
  let isCloudBase = false;
  try {
    const url = new URL(envBase);
    isCloudBase = url.protocol === "https:" && url.hostname === "ollama.com";
  } catch {
    // Invalid URL: not the cloud base.
  }
  if (!isCloudBase) {
    console.warn(
      `[pi-ollama-cloud] Ignoring OLLAMA_API_BASE=${envBase}; ` +
        `this extension always targets ${CLOUD_BASE_URL}. ` +
        `Unset OLLAMA_API_BASE (or set it to the cloud URL) to silence this warning.`,
    );
  }
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

export function assembleModels(raw: Record<string, OllamaShowResponse>): ProviderModelConfig[] {
  return Object.entries(raw)
    .filter(([, data]) => data.capabilities?.includes("tools"))
    .map(([id, data]) => ({
      id,
      name: id,
      reasoning: data.capabilities?.includes("thinking") ?? false,
      thinkingLevelMap: resolveThinkingLevelMap(id, data.capabilities ?? []),
      input: (data.capabilities?.includes("vision") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
      cost: resolvePrice(id),
      contextWindow: getContextLength(data.model_info ?? {}),
      // No per-model limit exposed by the API (https://docs.ollama.com/api-reference/show-model-details,
      // https://github.com/ollama/ollama/issues/7222). 32768 matches most Ollama Cloud context windows.
      maxTokens: 32768,
      compat: buildCompat(),
    }));
}

// --- Fetch Models ---
export async function fetchModelIds(signal?: AbortSignal, timeoutMs = FETCH_TIMEOUT_MS): Promise<string[]> {
  const headers: Record<string, string> = {};
  const apiKey = process.env.OLLAMA_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetchJsonWithTimeout<{ data: { id: string }[] }>(
    `${OLLAMA_BASE}/v1/models`,
    { headers },
    timeoutMs,
    signal,
  );

  if (res.status === 429) {
    throw new Error("Ollama Cloud rate limited. Try again shortly.");
  }
  if (!res.ok || !res.data) {
    throw new Error(`Failed to fetch model list: ${res.status}${res.error ? ` - ${res.error}` : ""}`);
  }

  return res.data.data.map((m) => m.id);
}

export async function fetchModelDetails(
  id: string,
  signal?: AbortSignal,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<OllamaShowResponse> {
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
    signal,
  );

  if (res.status === 429) {
    throw new Error("Ollama Cloud rate limited. Try again shortly.");
  }
  if (!res.ok || !res.data) {
    throw new Error(`Failed to fetch /api/show for ${id}: ${res.status}${res.error ? ` - ${res.error}` : ""}`);
  }

  return res.data;
}

/**
 * Fetch per-model /api/show details for a list of model IDs, 8 workers at a time.
 * Returns the models that succeeded. Throws when every detail request fails
 * (the zero-succeeded case), so the caller can surface a real failure instead
 * of an empty catalog.
 */
export async function refreshOllamaCloudModels(
  modelIds: string[],
  signal?: AbortSignal,
): Promise<{ models: Record<string, OllamaShowResponse>; failed: number }> {
  const detailResults = await concurrentMap(modelIds, 8, async (id) => {
    return [id, await fetchModelDetails(id, signal)] as const;
  });
  const models: Record<string, OllamaShowResponse> = {};
  let failed = 0;
  for (const result of detailResults) {
    if (result.status === "fulfilled") {
      const [id, data] = result.value;
      models[id] = data;
    } else {
      failed++;
    }
  }
  if (Object.keys(models).length === 0) {
    throw new Error(`Failed to fetch model details${failed ? ` (${failed} failed)` : ""}`);
  }
  return { models, failed };
}

// --- refreshModels callback ---

/**
 * The `refreshModels` callback pi invokes for the "ollama-cloud" provider.
 * Pi calls it twice per refresh: a restore phase (`allowNetwork: false`) before
 * auth resolution, then a network phase (`allowNetwork: true`) only when a
 * credential resolves. The composer swaps the return value into the model list
 * on every invocation, so this must never return `[]`.
 */
export async function refreshOllamaCatalog(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
  // The fallback list: the persisted snapshot (copied) when non-empty, else the
  // baked-in list. Guards against a stored empty catalog (e.g. a prior bad
  // refresh) propagating [] across sessions. A mutable copy is returned because
  // the stored list is `readonly` and the return type is a mutable array.
  const fallback = context.stored?.models.length ? [...context.stored.models] : GENERATED_MODELS;

  // Restore phase. Rehydrate from the persisted snapshot so removals stick
  // across sessions; fall back to the baked-in list on first launch. Also the
  // early-out for an already-aborted signal.
  if (!context.allowNetwork || context.signal.aborted) {
    return fallback;
  }

  // Cooldown: skip the network fetch when the stored catalog was checked within
  // the freshness window and the refresh isn't forced (mirrors pi-mono's
  // remote-catalog-provider). A forced refresh (pi update --models) always fetches.
  if (
    !context.force &&
    context.stored?.checkedAt !== undefined &&
    Date.now() - context.stored.checkedAt < REFRESH_COOLDOWN_MS
  ) {
    return fallback;
  }

  // Network phase. Pi's model-selector aborts a catalog refresh after 15s
  // (packages/coding-agent/src/modes/interactive/components/model-selector.ts
  // in pi-mono), so a cold refresh must stay under that budget or the in-memory
  // list won't update on the first picker-open. With ~18 models and 8 workers
  // this is ~1s today; revisit if the catalog grows or the API slows.
  let modelIds: string[];
  let raw: Record<string, OllamaShowResponse>;
  let failed = 0;
  try {
    modelIds = await fetchModelIds(context.signal);
    if (context.signal.aborted) {
      return fallback;
    }
    const result = await refreshOllamaCloudModels(modelIds, context.signal);
    raw = result.models;
    failed = result.failed;
  } catch (error) {
    // Abort mid-flight returns the current baseline; any other error propagates
    // and pi keeps the last good catalog (no publish was reached).
    if (context.signal.aborted) {
      return fallback;
    }
    throw error;
  }
  if (context.signal.aborted) {
    return fallback;
  }

  const models = assembleModels(raw);
  // Guard: an empty assembled list (e.g. the live API returned no tools-capable
  // models) must not be persisted or swapped in, or it would kill the provider
  // for the cooldown window. Keep the last good catalog instead.
  if (models.length === 0) {
    return fallback;
  }

  // The store is typed to pi-ai's internal Model shape, so rehydrate the live
  // list with the provider identity fields. A Model is structurally assignable
  // to ProviderModelConfig, so the same list is returned to pi (the composer
  // overrides provider/api/baseUrl on the in-memory swap regardless).
  const persisted = models.map((model) => ({
    ...model,
    provider: "ollama-cloud",
    api: "openai-completions",
    baseUrl: `${OLLAMA_BASE}/v1`,
  }));

  // Best-effort persistence into pi's FileModelsStore. The in-memory list swap
  // happens automatically from the return value, so a failed store write must
  // not prevent returning the fresh catalog.
  if (failed === 0) {
    // Fully successful: persist the fresh catalog.
    try {
      await context.publish({ persist: { models: persisted, checkedAt: Date.now() } });
    } catch {
      // Persistence failure is non-fatal.
    }
  } else {
    // Partial failure: keep the last-good catalog (if any) but advance checkedAt
    // so the cooldown applies and a flaky catalog isn't re-fetched on every
    // /model open, then surface the incomplete refresh. Mirrors pi-mono's
    // remote-catalog-provider, which persists then throws on a transient failure;
    // pi keeps the last-good catalog and reports the error.
    if (context.stored?.models.length) {
      try {
        await context.publish({ persist: { ...context.stored, checkedAt: Date.now() } });
      } catch {
        // Persistence failure is non-fatal.
      }
    }
    throw new Error(`Ollama Cloud catalog refresh incomplete: ${failed} model(s) failed`);
  }

  return persisted;
}
