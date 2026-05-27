/**
 * Ollama Cloud Provider Extension
 *
 * Registers Ollama Cloud as a model provider with dynamically fetched models.
 *
 * Setup:
 *   1. Get an API key from https://ollama.com
 *   2. Add to auth.json in the agent config dir (~/.pi/agent/auth.json, or set PI_CODING_AGENT_DIR):
 *      { "ollama-cloud": { "type": "api_key", "key": "your-key" } }
 *   3. Run /ollama-cloud-refresh to fetch model metadata
 *   4. Use /model or ctrl+l to select an Ollama Cloud model
 *
 * Two endpoints are used to build the model list:
 *   - GET  https://ollama.com/v1/models  -> list of model IDs
 *   - POST https://ollama.com/api/show   -> per-model details (capabilities, context length)
 *
 * Raw /api/show responses are cached at <agentDir>/cache/ollama-cloud-models.json
 * so the provider assembly can be debugged and re-derived without re-fetching.
 *
 * Local cache entries include timestamp. Stale local caches are used immediately while a visible startup
 * refresh runs; missing/invalid caches use a small hardcoded model list until refresh completes.
 *
 * Only models with "tools" capability are registered.
 */

import type { ExtensionAPI, ExtensionCommandContext, ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import {
  addFallbackModels,
  assembleModels,
  FALLBACK_ALIASES,
  FALLBACK_MODELS,
  fetchModels,
  OLLAMA_BASE,
  type RefreshProgress,
  readCacheState,
  writeCache,
} from "./models.ts";
import { registerWebFetchTool, registerWebSearchTool } from "./web-tools.ts";

/**
 * Opt-out flag for the ollama_web_search and ollama_web_fetch tools.
 * When the value is one of "0", "false", "no", "off", or the empty string,
 * both web tool registrations are skipped. The model provider and
 * /ollama-cloud-refresh command remain active regardless.
 */
const PI_OWT_RAW = process.env.PI_OLLAMA_WEB_TOOLS;
const WEB_TOOLS_DISABLED =
  PI_OWT_RAW !== undefined && ["0", "false", "no", "off", ""].includes(PI_OWT_RAW.toLowerCase());

// --- Registrations ---

function registerProvider(pi: ExtensionAPI, models: ProviderModelConfig[]) {
  pi.registerProvider("ollama-cloud", {
    baseUrl: `${OLLAMA_BASE}/v1`,
    apiKey: "OLLAMA_API_KEY",
    api: "openai-completions",
    models,
  });
}

function renderProgressBar(current: number, total: number, width = 15): string {
  if (total <= 0) return `[${"░".repeat(width)}]`;
  const ratio = Math.max(0, Math.min(1, current / total));
  const filled = Math.round(ratio * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function createRefreshProgressUi(ctx: Pick<ExtensionCommandContext, "ui">) {
  const key = "ollama-cloud-refresh";
  return {
    update(progress: RefreshProgress) {
      const current = progress.current ?? 0;
      const total = progress.total ?? 0;
      const percent = total > 0 ? Math.round((current / total) * 100) : 0;
      const failed = progress.failed ? `, ${progress.failed} failed` : "";
      const stage =
        progress.stage === "list"
          ? "Discovering models"
          : progress.stage === "details"
            ? "Fetching model details"
            : "Done";
      const summary = total > 0 ? `${current}/${total} (${percent}%${failed})` : progress.message;
      const line = `☁ Ollama Cloud - ${stage} — ${summary} ${renderProgressBar(current, total)}`;

      ctx.ui.setWorkingMessage(`Refreshing Ollama Cloud models - ${stage.toLowerCase()}`);
      ctx.ui.setWidget(key, [line], { placement: "belowEditor" });
    },
    clear() {
      ctx.ui.setWidget(key, undefined);
      ctx.ui.setStatus(key, undefined);
      ctx.ui.setWorkingMessage();
    },
  };
}

async function runRefresh(pi: ExtensionAPI, ctx: Pick<ExtensionCommandContext, "ui">) {
  const progressUi = createRefreshProgressUi(ctx);
  try {
    progressUi.update({ stage: "list", message: "Starting refresh..." });

    const raw = await fetchModels(ctx, (progress) => progressUi.update(progress));
    if (!raw) return false;

    writeCache(raw);
    const newModels = addFallbackModels(assembleModels(raw));

    registerProvider(pi, newModels);

    ctx.ui.notify(`Registered ${newModels.length} Ollama Cloud models`, "info");
    return true;
  } finally {
    progressUi.clear();
  }
}

function registerRefreshCommand(pi: ExtensionAPI) {
  pi.registerCommand("ollama-cloud-refresh", {
    description: "Refresh Ollama Cloud models from the API",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await runRefresh(pi, ctx);
    },
  });
}

// --- Main ---

export default async function (pi: ExtensionAPI) {
  const cacheState = readCacheState();
  const needsStartupRefresh = cacheState.status !== "fresh";
  const models = addFallbackModels(
    cacheState.status === "missing" ? FALLBACK_MODELS : assembleModels(cacheState.models)
  );

  registerProvider(pi, models);
  registerRefreshCommand(pi);

  // Transparently remap alias model IDs to real backend model IDs before
  // forwarding the request to the Ollama Cloud API.
  // This prevents 404 errors when a task is routed to e.g.
  // `ollama-cloud/qwen3.6-plus` which doesn't actually exist on
  // ollama.com; it silently falls back to `qwen3.5:397b` instead.
  pi.on("before_provider_request", async (event, ctx) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== "object" || !payload.model) return;

    // Defensive: only interfere for ollama-cloud provider.
    const activeModel = ctx.model as { provider?: string } | undefined;
    if (activeModel?.provider !== "ollama-cloud") return;

    const match = FALLBACK_ALIASES[payload.model as string];
    if (!match) return; // not an alias, pass through unchanged
    const realModelId = Array.isArray(match) ? match[0] : match;

    payload.model = realModelId;
    return payload;
  });

  if (needsStartupRefresh) {
    let started = false;
    pi.on("session_start", async (_event, ctx) => {
      if (started) return;
      started = true;
      await runRefresh(pi, ctx);
    });
  }

  if (!WEB_TOOLS_DISABLED) {
    registerWebSearchTool(pi);
    registerWebFetchTool(pi);
  }
}
