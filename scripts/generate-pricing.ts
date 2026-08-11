/**
 * Generate pricing.generated.ts from models.dev.
 *
 * Not shipped (not in package.json `files`). Run via `npm run generate-models`
 * (chained before the model generator) or directly via `tsx scripts/generate-pricing.ts`.
 *
 * Prices are estimated per-1M-token equivalents from models.dev
 * (https://models.dev/api.json), the same source pi itself uses. Ollama Cloud
 * is subscription-billed, so these are NOT actual charges; they make `/cost`
 * show comparable usage. Prices are never hand-typed: this script fetches them
 * and writes pricing.generated.ts (do not edit by hand).
 *
 * The curated OLLAMA_TO_MODELSDEV table maps each Ollama Cloud model ID to a
 * models.dev `{provider, modelId}`. Native pay-as-you-go providers are
 * preferred; models.dev's own `openrouter`/`togetherai` entries are used when
 * the native provider has no pay-as-you-go cost. Models with no mapping (or
 * whose models.dev entry is absent) get a zero price and a warning listing
 * them, so the next change adds one mapping line.
 */

import { writeFileSync } from "node:fs";
import { fetchModelIds } from "../models.ts";
import { fetchJsonWithTimeout } from "../utils.ts";

const MODELS_DEV_URL = "https://models.dev/api.json";
const TIMEOUT_MS = 15000;

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface ModelsDevCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

interface ModelsDevModel {
  cost?: ModelsDevCost | null;
}

interface ModelsDevProvider {
  models: Record<string, ModelsDevModel>;
}

interface ModelsDevResponse {
  [provider: string]: ModelsDevProvider;
}

/**
 * Curated mapping from Ollama Cloud model ID to models.dev {provider, modelId}.
 * One line per model. Add a line when a new Ollama model appears and rerun.
 */
const OLLAMA_TO_MODELSDEV: Record<string, { provider: string; modelId: string }> = {
  "deepseek-v4-flash": { provider: "deepseek", modelId: "deepseek-v4-flash" },
  "deepseek-v4-flash:0731": { provider: "deepseek", modelId: "deepseek-v4-flash" },
  "deepseek-v4-flash:preview": { provider: "deepseek", modelId: "deepseek-v4-flash" },
  "deepseek-v4-pro": { provider: "deepseek", modelId: "deepseek-v4-pro" },
  "gemma4:31b": { provider: "openrouter", modelId: "google/gemma-4-31b-it" },
  "glm-5.1": { provider: "zhipuai", modelId: "glm-5.1" },
  "glm-5.2": { provider: "zhipuai", modelId: "glm-5.2" },
  "gpt-oss:120b": { provider: "openrouter", modelId: "openai/gpt-oss-120b" },
  "gpt-oss:20b": { provider: "openrouter", modelId: "openai/gpt-oss-20b" },
  "kimi-k2.6": { provider: "moonshotai", modelId: "kimi-k2.6" },
  "kimi-k2.7-code": { provider: "moonshotai", modelId: "kimi-k2.7-code" },
  "kimi-k3": { provider: "moonshotai", modelId: "kimi-k3" },
  "minimax-m2.7": { provider: "minimax", modelId: "MiniMax-M2.7" },
  "minimax-m3": { provider: "minimax", modelId: "MiniMax-M3" },
  "mistral-large-3:675b": { provider: "mistral", modelId: "mistral-large-2512" },
  "nemotron-3-nano:30b": { provider: "openrouter", modelId: "nvidia/nemotron-3-nano-30b-a3b" },
  "nemotron-3-super": { provider: "nvidia", modelId: "nvidia/nemotron-3-super-120b-a12b" },
  "nemotron-3-ultra": { provider: "nvidia", modelId: "nvidia/nemotron-3-ultra-550b-a55b" },
  "qwen3.5:397b": { provider: "alibaba", modelId: "qwen3.5-397b-a17b" },
};

const ZERO: ModelPrice = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function priceFromCost(cost: ModelsDevCost | null | undefined): ModelPrice {
  if (!cost) return { ...ZERO };
  return {
    input: cost.input ?? 0,
    output: cost.output ?? 0,
    cacheRead: cost.cache_read ?? 0,
    cacheWrite: cost.cache_write ?? 0,
  };
}

async function main(): Promise<void> {
  console.log("Fetching models.dev api.json...");
  const res = await fetchJsonWithTimeout<ModelsDevResponse>(MODELS_DEV_URL, {}, TIMEOUT_MS);
  if (!res.ok || !res.data) {
    throw new Error(`models.dev API returned ${res.status}: ${res.error ?? "<no body>"}`);
  }
  const modelsDev = res.data;

  console.log("Fetching Ollama Cloud model list...");
  const ollamaIds = (await fetchModelIds()).sort();

  const pricing: Record<string, ModelPrice> = {};
  const warnings: string[] = [];

  for (const id of ollamaIds) {
    const mapping = OLLAMA_TO_MODELSDEV[id];
    if (!mapping) {
      pricing[id] = { ...ZERO };
      warnings.push(`no models.dev mapping for "${id}" (zero cost)`);
      continue;
    }
    const provider = modelsDev[mapping.provider];
    const model = provider?.models?.[mapping.modelId];
    if (!provider || !model) {
      pricing[id] = { ...ZERO };
      warnings.push(`models.dev entry not found for "${id}" (${mapping.provider}/${mapping.modelId}) (zero cost)`);
      continue;
    }
    pricing[id] = priceFromCost(model.cost);
  }

  if (warnings.length > 0) {
    console.warn("Pricing warnings:");
    for (const w of warnings) console.warn(`  - ${w}`);
  }

  const generatedAt = new Date().toISOString();
  const lines: string[] = [
    "// Auto-generated by scripts/generate-pricing.ts",
    "// Do not edit manually.",
    `// Generated: ${generatedAt}`,
    `// Model count: ${ollamaIds.length}`,
    "",
    "export interface ModelPrice {",
    "  input: number;",
    "  output: number;",
    "  cacheRead: number;",
    "  cacheWrite: number;",
    "}",
    "",
    "export const MODEL_PRICING: Record<string, ModelPrice> = {",
  ];
  for (const id of Object.keys(pricing).sort()) {
    const p = pricing[id];
    lines.push(
      `  ${JSON.stringify(id)}: { input: ${p.input}, output: ${p.output}, cacheRead: ${p.cacheRead}, cacheWrite: ${p.cacheWrite} },`,
    );
  }
  lines.push("};", "");

  writeFileSync(new URL("../pricing.generated.ts", import.meta.url), lines.join("\n"));
  console.log(`Wrote pricing.generated.ts (${ollamaIds.length} models, ${warnings.length} warnings).`);
}

await main();
