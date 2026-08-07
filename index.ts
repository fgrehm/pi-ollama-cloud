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

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  OAuthCredentials,
  OAuthLoginCallbacks,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, resolveWebToolsEnv } from "./config.ts";
import { GENERATED_MODELS } from "./models.generated.ts";
import {
  assembleModels,
  fetchModels,
  OLLAMA_BASE,
  type RefreshProgress,
  readCacheState,
  writeCache,
} from "./models.ts";
import { registerWebFetchTool, registerWebSearchTool } from "./web-tools.ts";

// --- Registrations ---

/**
 * API-key login flow for `/login`.
 *
 * Ollama Cloud has no OAuth; this uses pi's oauth hook as an interactive
 * API-key flow (prompt -> validate -> persist), the same pattern pi's built-in
 * llama.cpp provider uses. The key is stored in the standard credential
 * `access` field; `refreshToken` is a no-op because API keys do not expire.
 */
async function loginWithApiKey(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const key = (
    await callbacks.onPrompt({
      message: "Paste your Ollama Cloud API key (create one at https://ollama.com/settings/keys)",
      placeholder: "API key",
    })
  ).trim();
  if (!key) throw new Error("No API key provided");

  // Validate against an authenticated endpoint. Only a definite auth failure
  // rejects the key; transient network errors must not block login.
  callbacks.onProgress?.("Validating API key...");
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/web_search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "ping", max_results: 1 }),
      signal: callbacks.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("Ollama Cloud rejected this API key (HTTP " + res.status + ")");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Ollama Cloud rejected")) throw error;
    callbacks.onProgress?.("Could not reach ollama.com to validate; storing key anyway");
  }

  return { refresh: "", access: key, expires: Number.MAX_SAFE_INTEGER };
}

function registerProvider(pi: ExtensionAPI, models: ProviderModelConfig[]) {
  pi.registerProvider("ollama-cloud", {
    name: "Ollama Cloud",
    baseUrl: `${OLLAMA_BASE}/v1`,
    apiKey: "$OLLAMA_API_KEY",
    api: "openai-completions",
    models,
    oauth: {
      name: "Ollama Cloud (API key)",
      login: loginWithApiKey,
      // API keys do not expire; hand the same credentials back.
      refreshToken: async (credentials) => credentials,
      getApiKey: (credentials) => String(credentials.access),
    },
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
  // Auto-refresh only when the disk cache is stale (>30 days).
  // When cache is missing, GENERATED_MODELS serves as the cache —
  // it is manually generated via `npm run generate-models` and committed to the repo.
  const needsStartupRefresh = cacheState.status === "stale";
  // GENERATED_MODELS ships with the package. Used when no local cache exists. A
  // fresh user cache from /ollama-cloud-refresh takes precedence over the generated list.
  const models = cacheState.status === "missing" ? GENERATED_MODELS : assembleModels(cacheState.models);

  registerProvider(pi, models);
  registerRefreshCommand(pi);

  if (needsStartupRefresh) {
    let started = false;
    pi.on("session_start", async (_event, ctx) => {
      if (started) return;
      started = true;
      await runRefresh(pi, ctx);
    });
  }

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
