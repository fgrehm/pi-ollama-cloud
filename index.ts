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
import { fetchBalance, fetchUsageStats, formatBalance, formatBalanceStatusColored } from "./usage.ts";
import { getCloudApiKey } from "./utils.ts";
import { registerWebFetchTool, registerWebSearchTool } from "./web-tools.ts";

/** Guard usage-status refreshes against stale generations and duplicate triggers. */
export function createUsageStatusRefreshGuard() {
  let generation = 0;
  let inFlightGeneration: number | undefined;

  return {
    invalidate() {
      generation += 1;
    },
    async run(
      isCurrent: () => boolean,
      refresh: (stillCurrent: () => boolean) => Promise<string | undefined>,
      setStatus: (text: string | undefined) => void,
    ): Promise<void> {
      if (inFlightGeneration === generation || !isCurrent()) return;
      const requestGeneration = generation;
      inFlightGeneration = requestGeneration;
      try {
        const text = await refresh(() => generation === requestGeneration && isCurrent());
        if (generation === requestGeneration && isCurrent()) setStatus(text);
      } catch {
        if (generation === requestGeneration && isCurrent()) setStatus(undefined);
      } finally {
        if (inFlightGeneration === requestGeneration) inFlightGeneration = undefined;
      }
    },
  };
}

/** Resolve the new enabled state for /ollama-usage-status from its argument. */
export function resolveUsageStatusToggle(arg: string, current: boolean): { enabled: boolean; error?: string } {
  const a = arg.trim().toLowerCase();
  if (a === "on" || a === "enable") return { enabled: true };
  if (a === "off" || a === "disable") return { enabled: false };
  if (a === "") return { enabled: !current };
  return {
    enabled: current,
    error: `Unknown argument "${arg.trim()}". Usage: /ollama-usage-status [on|off|enable|disable]`,
  };
}

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

  // Config is read once per extension factory invocation (on the first
  // session_start). The factory is re-invoked on /new, /fork, /resume, and
  // /reload, so runtime toggles (e.g. /ollama-webtools, /ollama-usage-status)
  // reset to the config default on each session restart. Restart pi or /reload
  // to pick up config file changes.
  let configLoaded = false;
  let webToolsEnabled = false;
  let usageStatusEnabled = false;

  pi.on("session_start", async (_event, ctx) => {
    if (!configLoaded) {
      configLoaded = true;
      const config = loadConfig(ctx.cwd);
      if (config.webTools !== false) {
        webToolsEnabled = true;
        ensureWebToolsRegistered();
      }
      // The status bar is opt-in: enabled only when the config explicitly sets it true.
      usageStatusEnabled = config.usageStatus === true;
    }
    // On every session start (including resume/fork/new), re-apply the
    // runtime state. Tools may have been unregistered during teardown.
    if (webToolsEnabled) {
      ensureWebToolsRegistered();
      setWebToolsActive(true);
    }
    // Start the usage status bar when ollama-cloud is the active provider.
    if (usageStatusEnabled && isOllamaCloud(ctx)) {
      startUsageStatus(ctx);
    }
  });

  // --- Usage Command ---

  pi.registerCommand("ollama-cloud-usage", {
    description: "Show Ollama Cloud usage limits.",
    handler: async (_args, ctx) => {
      const apiKey = await getCloudApiKey(ctx);
      if (!apiKey) {
        ctx.ui.notify("No Ollama Cloud API key configured. Set OLLAMA_API_KEY or add to auth.json.", "error");
        return;
      }
      try {
        const balance = await fetchBalance(apiKey);
        let text = formatBalance(balance);
        try {
          // The histogram endpoint is rate-limited (~1 req/s); space the calls
          // so the informational fetch does not get 429'd.
          await new Promise((resolve) => setTimeout(resolve, 1100));
          text = formatBalance(balance, await fetchUsageStats(apiKey));
        } catch {
          // Histogram is informational; a failure keeps the balance output.
        }
        ctx.ui.notify(text, "info");
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });

  // --- Usage Status Bar ---

  // Footer status showing live usage while ollama-cloud is the
  // active provider. Refreshes on a 5-minute timer; agent_end also triggers a
  // refresh but is throttled to the same cooldown so a turn never hammers the
  // undocumented /api/balance endpoint. The quota-bar concept is inspired by
  // @entelligentsia/pi-ollama-cloud-usage-tracker.
  const USAGE_STATUS_KEY = "ollama-usage";
  const USAGE_REFRESH_MS = 5 * 60_000;
  let usageTimer: ReturnType<typeof setInterval> | null = null;
  let usageActive = false;
  const usageRefreshGuard = createUsageStatusRefreshGuard();
  // Timestamp (ms) of the most recent refresh attempt; gates the agent_end
  // refresh so it fires at most once per cooldown. Set when a fetch starts, so
  // a failing endpoint is also throttled, not just a successful one.
  let lastRefreshAt = 0;

  async function refreshUsageStatus(ctx: ExtensionContext) {
    await usageRefreshGuard.run(
      () => usageActive && isOllamaCloud(ctx),
      async (stillCurrent) => {
        const apiKey = await getCloudApiKey(ctx);
        if (!stillCurrent() || !apiKey) return undefined;
        lastRefreshAt = Date.now();
        const balance = await fetchBalance(apiKey);
        // Clear (rather than show "") when only credits are present.
        return formatBalanceStatusColored(ctx.ui.theme, balance) || undefined;
      },
      (text) => ctx.ui.setStatus(USAGE_STATUS_KEY, text),
    );
  }

  function startUsageStatus(ctx: ExtensionContext) {
    if (usageActive) return;
    // The status bar is TUI-only; skip the fetch and timer in print/json/rpc.
    if (ctx.mode !== "tui") return;
    usageActive = true;
    refreshUsageStatus(ctx);
    usageTimer = setInterval(() => refreshUsageStatus(ctx), USAGE_REFRESH_MS);
  }

  function stopUsageStatus(ctx: ExtensionContext) {
    usageRefreshGuard.invalidate();
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
    if (usageStatusEnabled && isOllamaCloud(ctx)) {
      startUsageStatus(ctx);
    } else {
      stopUsageStatus(ctx);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    // Throttle the after-turn refresh to the same cooldown as the timer so a
    // burst of turns never exceeds one /api/usage call per 5 minutes.
    if (usageActive && isOllamaCloud(ctx) && Date.now() - lastRefreshAt >= USAGE_REFRESH_MS) {
      await refreshUsageStatus(ctx);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopUsageStatus(ctx);
  });

  pi.registerCommand("ollama-usage-status", {
    description:
      "Enable or disable the Ollama Cloud usage status bar. " +
      "Accepts optional argument: on/off/enable/disable. Without argument, toggles.",
    handler: async (args, ctx) => {
      const { enabled, error } = resolveUsageStatusToggle(args, usageStatusEnabled);
      if (error) {
        ctx.ui.notify(error, "error");
        return;
      }
      usageStatusEnabled = enabled;

      if (usageStatusEnabled && isOllamaCloud(ctx)) {
        startUsageStatus(ctx);
      } else {
        stopUsageStatus(ctx);
      }

      ctx.ui.notify(`Ollama Cloud usage status: ${usageStatusEnabled ? "enabled" : "disabled"}`, "info");
    },
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
