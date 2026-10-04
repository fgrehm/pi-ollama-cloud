#!/usr/bin/env tsx
/**
 * Probes per-model max output tokens from the live API and writes
 * limits.generated.ts. Run manually (or via CI) and commit the output.
 *
 * Usage:
 *   npm run generate-limits          # probe every model, using auth.json or OLLAMA_API_KEY
 *   npm run generate-limits <model>  # probe one model, merge into the table
 *
 * When a single model id is given, only that model is probed and its limit is
 * merged into the existing limits.generated.ts, leaving every other entry
 * untouched. This is the intended workflow when the catalog gains a model:
 * probe the newcomer instead of re-probing all 20.
 *
 * The /api/show endpoint does not expose an output limit
 * (https://docs.ollama.com/api-reference/show-model-details,
 * https://github.com/ollama/ollama/issues/7222; see also upstream request to
 * expose per-model metadata, https://github.com/ollama/ollama/issues/18385),
 * so each model is probed with
 * a minimal chat completion: an ascending max_tokens tier plus a stop
 * sequence. A rejected request reports the exact limit in the error message:
 *   max_tokens (100000) exceeds model's maximum output tokens (65536) for model ...
 *
 * Models whose limit could not be determined are omitted from the generated
 * table and fall back to 32768 at runtime (see resolveMaxTokens in models.ts).
 */

import { writeFileSync } from "node:fs";
import { MODEL_MAX_OUTPUT_TOKENS } from "../limits.generated.ts";
import { fetchModelIds, OLLAMA_BASE } from "../models.ts";
import { concurrentMap, fetchJsonWithTimeout } from "../utils.ts";
import { resolveOllamaCloudApiKey } from "./ollama-cloud-auth.ts";

const PROBE_TIERS = [65536, 131072, 262144, 524288];
// Generous timeout: some models (e.g. nemotron-3-ultra) take >15s to first
// token, and a timeout drops the model from the table (32768 fallback at
// runtime), which is worse than a slow probe.
const PROBE_TIMEOUT_MS = 60000;
const LIMIT_RE = /maximum output tokens \((\d+)\)/;

/** Probe one model; returns the exact limit, or undefined when unknown. */
async function probeMaxTokens(id: string, apiKey: string): Promise<number | undefined> {
  const limit = PROBE_TIERS[PROBE_TIERS.length - 1];
  for (const tier of PROBE_TIERS) {
    const res = await fetchJsonWithTimeout<{ error?: { message?: string } }>(
      `${OLLAMA_BASE}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: id,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          max_tokens: tier,
          stop: ["OK"],
        }),
      },
      PROBE_TIMEOUT_MS,
    );
    if (res.ok) {
      // Limit is at least this tier; keep ascending.
      continue;
    }
    const match = LIMIT_RE.exec(res.error ?? "");
    if (match) {
      return Number(match[1]);
    }
    // Rejected for a reason we cannot parse (e.g. billing, rate limit).
    return undefined;
  }
  console.warn(`  ${id} accepted the max probe tier (${limit}); its real limit may be higher.`);
  return limit;
}

function requireApiKey(apiKey: string | undefined): string {
  if (apiKey) return apiKey;
  console.error("No Ollama Cloud API key found. Add an ollama-cloud entry to auth.json or set OLLAMA_API_KEY.");
  process.exit(1);
}

const apiKey = requireApiKey(resolveOllamaCloudApiKey().apiKey);

const targetId = process.argv[2];

interface ProbeResult {
  limits: Record<string, number>;
  /** Models probed fresh in the run that wrote the file. */
  probed: number;
  /**
   * Indeterminate probes. A successful run may still carry these forward
   * (option (b): only hard-fail when nothing usable came back), but any
   * count above zero is reported loudly so the merge is never silent.
   */
  failed: number;
}

async function probeAll(): Promise<ProbeResult> {
  console.log("Fetching Ollama Cloud models...");
  const modelIds = await fetchModelIds();
  console.log(`Probing ${modelIds.length} models for max output tokens...`);

  const results = await concurrentMap(modelIds, 8, async (id) => ({ id, limit: await probeMaxTokens(id, apiKey) }));

  const limits: Record<string, number> = {};
  let failed = 0;
  // concurrentMap pre-allocates its result array by index, so results map
  // back onto modelIds and rejected probes keep their model id instead of
  // reporting an unusable "unknown".
  for (const [index, result] of results.entries()) {
    const id = modelIds[index];
    if (result.status === "fulfilled" && result.value.limit !== undefined) {
      limits[result.value.id] = result.value.limit;
    } else {
      failed++;
      // Indeterminate (timeout, billing, rate limit): the probe does not
      // prove the model is gone, so keep any existing model-specific limit
      // rather than dropping it to the 32768 runtime fallback. Models that
      // were removed from the catalog are excluded automatically because
      // only current model ids are probed here.
      const cached = MODEL_MAX_OUTPUT_TOKENS[id];
      if (cached !== undefined) {
        limits[id] = cached;
      }
      console.warn(`  no limit for ${id}; keeping its existing limit if any`);
    }
  }
  return { limits, probed: modelIds.length, failed };
}

async function probeOne(targetId: string): Promise<ProbeResult> {
  // The generated table ships at runtime; merge the single fresh limit into its
  // current contents so an unchanged catalog is not re-probed every time.
  const probe = await probeMaxTokens(targetId, apiKey);
  const limits = { ...MODEL_MAX_OUTPUT_TOKENS };
  let failed = 0;
  if (probe === undefined) {
    // Indeterminate (timeout, billing, rate limit): the probe does not prove
    // the model is gone, so keep any existing model-specific limit rather than
    // dropping the entry to the 32768 runtime fallback.
    failed = 1;
    console.warn(`  no limit for ${targetId}; keeping its existing limit if any`);
  } else {
    limits[targetId] = probe;
    console.log(`  ${targetId} -> ${probe}`);
  }
  return { limits, probed: 1, failed };
}

const { limits, probed, failed } = targetId ? await probeOne(targetId) : await probeAll();

// Fail loudly when nothing usable came back. A stray indeterminate probe on a
// known-slow model is tolerated (existing limits are carried forward and the
// warning above is loud), but aborting the write entirely is worse than
// shipping a table that cannot probe anything fresh.
if (probed > 0 && probed === failed) {
  console.error(`generate-limits: no usable probe data for ${probed} model(s); refusing to write limits.generated.ts.`);
  process.exit(1);
}

const out = [
  "// Auto-generated by scripts/generate-limits.ts",
  "// Do not edit manually.",
  `// Entries: ${Object.keys(limits).length}`,
  "",
  "export const MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = {",
  ...Object.keys(limits)
    .sort()
    .map((id) => `  ${JSON.stringify(id)}: ${limits[id]},`),
  "};",
  "",
].join("\n");

writeFileSync("limits.generated.ts", out);
console.log(`Wrote limits.generated.ts (${Object.keys(limits).length} entries; probed ${probed}, ${failed} failed).`);
