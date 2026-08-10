/**
 * Ollama Cloud Provider Extension
 *
 * Registers Ollama Cloud as a model provider with a baked-in fallback catalog
 * and a native `refreshModels` callback that overlays live API updates.
 *
 * Setup:
 *   1. Get an API key from https://ollama.com
 *   2. Add to auth.json in the agent config dir (~/.pi/agent/auth.json, or set PI_CODING_AGENT_DIR):
 *      { "ollama-cloud": { "type": "api_key", "key": "your-key" } }
 *   3. Use /model or ctrl+l to select an Ollama Cloud model
 *
 * Two endpoints are used to build the model list:
 *   - GET  https://ollama.com/v1/models  -> list of model IDs
 *   - POST https://ollama.com/api/show   -> per-model details (capabilities, context length)
 *
 * Catalog behavior:
 *   - The baked-in GENERATED_MODELS list (via `npm run generate-models`) is the
 *     first-launch fallback when no persisted catalog exists.
 *   - On startup, /model open, and `pi update --models`, pi calls the
 *     `refreshModels` callback, which fetches the live catalog and persists it
 *     through pi's own FileModelsStore. Refresh is automatic.
 *
 * Only models with "tools" capability are registered.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, resolveWebToolsEnv } from "./config.ts";
import { GENERATED_MODELS } from "./models.generated.ts";
import { OLLAMA_BASE, refreshOllamaCatalog } from "./models.ts";
import { fetchUsage, formatUsage, formatUsageStatus } from "./usage.ts";
import { getCloudApiKey, registerWebFetchTool, registerWebSearchTool } from "./web-tools.ts";

// --- Main ---

export default async function (pi: ExtensionAPI) {
  pi.registerProvider("ollama-cloud", {
    name: "Ollama Cloud",
    baseUrl: `${OLLAMA_BASE}/v1`,
    apiKey: "$OLLAMA_API_KEY",
    api: "openai-completions",
    models: GENERATED_MODELS,
    refreshModels: refreshOllamaCatalog,
  });

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
    // Start the usage status bar when ollama-cloud is the active provider.
    if (isOllamaCloud(ctx)) {
      startUsageStatus(ctx);
    }
  });

  // --- Usage Command ---

  pi.registerCommand("ollama-cloud-usage", {
    description: "Show Ollama Cloud session and weekly usage limits.",
    handler: async (_args, ctx) => {
      const apiKey = await getCloudApiKey(ctx);
      if (!apiKey) {
        ctx.ui.notify("No Ollama Cloud API key configured. Set OLLAMA_API_KEY or add to auth.json.", "error");
        return;
      }
      try {
        const data = await fetchUsage(apiKey);
        ctx.ui.notify(formatUsage(data), "info");
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });

  // --- Usage Status Bar ---

  // Footer status showing live session/weekly usage while ollama-cloud is the
  // active provider. Refreshes on a timer and after each agent turn. The
  // quota-bar concept is inspired by @entelligentsia/pi-ollama-cloud-usage-tracker.
  const USAGE_STATUS_KEY = "ollama-usage";
  const USAGE_REFRESH_MS = 5 * 60_000;
  let usageTimer: ReturnType<typeof setInterval> | null = null;
  let usageActive = false;

  async function refreshUsageStatus(ctx: ExtensionContext) {
    const apiKey = await getCloudApiKey(ctx);
    if (!apiKey) {
      ctx.ui.setStatus(USAGE_STATUS_KEY, undefined);
      return;
    }
    try {
      const data = await fetchUsage(apiKey);
      ctx.ui.setStatus(USAGE_STATUS_KEY, formatUsageStatus(data));
    } catch {
      // Transient errors (undocumented endpoint, network) should not spam the
      // footer; clear the status and retry on the next refresh.
      ctx.ui.setStatus(USAGE_STATUS_KEY, undefined);
    }
  }

  function startUsageStatus(ctx: ExtensionContext) {
    if (usageActive) return;
    usageActive = true;
    refreshUsageStatus(ctx);
    usageTimer = setInterval(() => refreshUsageStatus(ctx), USAGE_REFRESH_MS);
  }

  function stopUsageStatus(ctx: ExtensionContext) {
    usageActive = false;
    if (usageTimer) {
      clearInterval(usageTimer);
      usageTimer = null;
    }
    ctx.ui.setStatus(USAGE_STATUS_KEY, undefined);
  }

  function isOllamaCloud(ctx: ExtensionContext): boolean {
    return ctx.model?.provider === "ollama-cloud";
  }

  pi.on("model_select", async (_event, ctx) => {
    if (isOllamaCloud(ctx)) {
      startUsageStatus(ctx);
    } else {
      stopUsageStatus(ctx);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (usageActive && isOllamaCloud(ctx)) {
      await refreshUsageStatus(ctx);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopUsageStatus(ctx);
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
