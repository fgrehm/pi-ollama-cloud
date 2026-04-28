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

import type { ExtensionAPI, ExtensionCommandContext, ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { assembleModels, FALLBACK_MODELS, fetchModels, OLLAMA_BASE, readCache, writeCache } from "./models.ts";
import { registerWebFetchTool, registerWebSearchTool } from "./web-tools.ts";

/**
 * Opt-out flag for the ollama_web_search and ollama_web_fetch tools.
 * When the value is one of "0", "false", "no", "off", or the empty string,
 * both web tool registrations are skipped. The model provider and
 * /ollama-cloud-refresh command remain active regardless.
 */
const PI_OWT_RAW = process.env.PI_OLLAMA_WEB_TOOLS;
const WEB_TOOLS_DISABLED = PI_OWT_RAW !== undefined && ["0", "false", "no", "off", ""].includes(PI_OWT_RAW);

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
