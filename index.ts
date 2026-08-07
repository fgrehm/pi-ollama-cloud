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
 * Startup behavior:
 *   - Missing cache: uses baked-in GENERATED_MODELS (manually generated via
 *     `npm run generate-models` and committed to the repo).
 *   - Stale cache (>30 days): uses the cached data immediately and triggers a visible refresh
 *     on session_start that shows progress in the UI widget.
 *   - Fresh cache: uses cached data directly, no refresh triggered.
 *
 * Only models with "tools" capability are registered.
 */

import type { ExtensionAPI, ExtensionCommandContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { loadConfig, resolveWebToolsEnv } from "./config.ts";
import { GENERATED_MODELS } from "./models.generated.ts";
import {
  assembleModels,
  fetchModels,
  OLLAMA_BASE,
  type RefreshProgress,
  readCacheState,
  refreshOllamaCloudModels,
  writeCache,
} from "./models.ts";
import { registerWebFetchTool, registerWebSearchTool } from "./web-tools.ts";

// --- Registrations ---

/**
 * Catalog refresh through pi's native model-refresh pipeline.
 *
 * Pi calls this whenever it refreshes model catalogs: at startup, when the
 * `/model` picker opens, and right after a successful `/login`. That last one
 * matters most - without this hook a fresh login leaves the provider on the
 * baked-in list until the user discovers `/ollama-cloud-refresh`.
 *
 * The network-cost policy is unchanged. A full refresh is one list call plus
 * one `/api/show` per model, so this only goes to the network when the caller
 * forced a refresh or the on-disk cache is stale/missing; a fresh cache is
 * answered from disk with no requests.
 */
async function refreshModelsForPi(
  context: { allowNetwork: boolean; force?: boolean; signal: AbortSignal },
  fallback: ProviderModelConfig[],
): Promise<ProviderModelConfig[]> {
  // Offline restore phase, or already cancelled: keep the current list.
  if (!context.allowNetwork || context.signal.aborted) return fallback;

  const cache = readCacheState();
  if (!context.force && cache.status === "fresh") return assembleModels(cache.models);

  const raw = await refreshOllamaCloudModels({});
  if (context.signal.aborted) return fallback;
  writeCache(raw);
  return assembleModels(raw);
}

function registerProvider(pi: ExtensionAPI, models: ProviderModelConfig[]) {
  pi.registerProvider("ollama-cloud", {
    name: "Ollama Cloud",
    baseUrl: `${OLLAMA_BASE}/v1`,
    apiKey: "$OLLAMA_API_KEY",
    api: "openai-completions",
    models,
    refreshModels: (context) => refreshModelsForPi(context, models),
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
    const newModels = assembleModels(raw);

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
  // GENERATED_MODELS ships with the package. Used when no local cache exists. A
  // fresh user cache takes precedence over the generated list.
  const models = cacheState.status === "missing" ? GENERATED_MODELS : assembleModels(cacheState.models);

  registerProvider(pi, models);
  registerRefreshCommand(pi);

  // A stale cache no longer needs its own session_start refresh: refreshModels
  // runs inside pi's catalog refresh (startup, /model, post-login) and
  // re-fetches whenever the cache is stale.

  // --- Web Tools Management ---

  /**
   * Ensure web tools are registered (idempotent).
   * Returns true if any tools were newly registered.
   */
  function ensureWebToolsRegistered(): boolean {
    const allTools = pi.getAllTools();
    let registered = false;
    if (!allTools.some((t) => t.name === "ollama_web_search")) {
      registerWebSearchTool(pi);
      registered = true;
    }
    if (!allTools.some((t) => t.name === "ollama_web_fetch")) {
      registerWebFetchTool(pi);
      registered = true;
    }
    return registered;
  }

  /**
   * Add or remove web tools from the active tools set.
   */
  function setWebToolsActive(active: boolean) {
    const currentActive = pi.getActiveTools();
    const webToolNames = ["ollama_web_search", "ollama_web_fetch"];

    if (active) {
      const missing = webToolNames.filter((n) => !currentActive.includes(n));
      if (missing.length > 0) {
        pi.setActiveTools([...currentActive, ...missing]);
      }
    } else {
      const filtered = currentActive.filter((t) => !webToolNames.includes(t));
      if (filtered.length < currentActive.length) {
        pi.setActiveTools(filtered);
      }
    }
  }

  // Module-level tracking across session restarts within the same extension
  // instance. The config file is read once, on the first session_start;
  // later sessions reuse webToolsEnabled (including any /ollama-webtools
  // override). Restart pi or /reload to pick up config file changes.
  let webToolsConfigured = false;
  let webToolsEnabled = false;

  pi.on("session_start", async (_event, ctx) => {
    if (!webToolsConfigured) {
      webToolsConfigured = true;
      const config = loadConfig(ctx.cwd);
      if (config.webTools !== false) {
        webToolsEnabled = true;
        ensureWebToolsRegistered();
      }
    }
    // On every session start (including resume/fork/new), re-apply the
    // runtime state. Tools may have been unregistered during teardown.
    if (webToolsEnabled) {
      ensureWebToolsRegistered();
      setWebToolsActive(true);
    }
  });

  // Only register the runtime toggle command when the env var doesn't force tools off.
  // PI_OLLAMA_WEB_TOOLS acts as a hard kill switch — no command to re-enable.
  if (resolveWebToolsEnv() !== false) {
    pi.registerCommand("ollama-webtools", {
      description:
        "Enable or disable Ollama Cloud web tools (ollama_web_search, ollama_web_fetch). " +
        "Accepts optional argument: on/off/enable/disable. Without argument, toggles.",
      handler: async (args, ctx) => {
        const arg = args.trim().toLowerCase();

        if (arg === "on" || arg === "enable") {
          webToolsEnabled = true;
        } else if (arg === "off" || arg === "disable") {
          webToolsEnabled = false;
        } else if (arg === "") {
          // Toggle current state
          webToolsEnabled = !webToolsEnabled;
        } else {
          ctx.ui.notify(`Unknown argument "${args.trim()}". Usage: /ollama-webtools [on|off|enable|disable]`, "error");
          return;
        }

        if (webToolsEnabled) {
          ensureWebToolsRegistered();
          setWebToolsActive(true);
        } else {
          setWebToolsActive(false);
        }

        ctx.ui.notify(`Ollama Web Tools: ${webToolsEnabled ? "enabled" : "disabled"}`, "info");
      },
    });
  }
}
