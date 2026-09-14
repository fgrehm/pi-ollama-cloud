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
import { loadConfig, resolveUsageDisplay, resolveWebToolsEnv } from "./config.ts";
import { GENERATED_MODELS } from "./models.generated.ts";
import { OLLAMA_BASE, refreshOllamaCatalog } from "./models.ts";
import { createSidebarUsagePublisher } from "./sidebar.ts";
import { fetchUsage, formatUsage, formatUsageStatusColored, type UsageData, usagePanelRows } from "./usage.ts";
import { getCloudApiKey } from "./utils.ts";
import { registerWebFetchTool, registerWebSearchTool } from "./web-tools.ts";

type UsageDisplayMode = "sidebar" | "statusbar" | "off";

const USAGE_USAGE = "Usage: /ollama-usage-status [sidebar|statusbar|off|on|enable|disable] (no argument toggles)";

/**
 * Resolve the new display mode for /ollama-usage-status from its argument.
 * Enabling or toggling on selects the sidebar default. Exported for unit testing.
 */
export function resolveUsageStatusToggle(
  arg: string,
  current: UsageDisplayMode,
): { mode: UsageDisplayMode; error?: string } {
  const a = arg.trim().toLowerCase();
  if (a === "sidebar") return { mode: "sidebar" };
  if (a === "statusbar") return { mode: "statusbar" };
  if (a === "off" || a === "disable") return { mode: "off" };
  if (a === "on" || a === "enable") return { mode: "sidebar" };
  if (a === "") return { mode: current === "off" ? "sidebar" : "off" };
  return {
    mode: current,
    error: `Unknown argument "${arg.trim()}". ${USAGE_USAGE}`,
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
  let usageDisplay: UsageDisplayMode = "sidebar";

  pi.on("session_start", async (_event, ctx) => {
    if (!configLoaded) {
      configLoaded = true;
      const config = loadConfig(ctx.cwd);
      if (config.webTools !== false) {
        webToolsEnabled = true;
        ensureWebToolsRegistered();
      }
      usageDisplay = resolveUsageDisplay(config);
    }
    // On every session start (including resume/fork/new), re-apply the
    // runtime state. Tools may have been unregistered during teardown.
    if (webToolsEnabled) {
      ensureWebToolsRegistered();
      setWebToolsActive(true);
    }
    // Start the usage display when ollama-cloud is the active provider.
    if (usageDisplay !== "off" && isOllamaCloud(ctx)) {
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
        const data = await fetchUsage(apiKey);
        ctx.ui.notify(formatUsage(data), "info");
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });

  // --- Usage Display ---

  // Live usage while ollama-cloud is the active provider, rendered to the
  // sidebar panel (sidebar mode with a compatible Pi Atelier host) or the
  // footer status bar. Refreshes on a 5-minute timer; agent_end also triggers
  // a refresh but is throttled to the same cooldown so a turn never hammers
  // the undocumented /api/usage endpoint. One refresh point fans out to the
  // effective destination, so sidebar and footer output stay mutually
  // exclusive. The quota-bar concept is inspired by
  // @entelligentsia/pi-ollama-cloud-usage-tracker.
  const USAGE_STATUS_KEY = "ollama-usage";
  const USAGE_REFRESH_MS = 5 * 60_000;
  let usageTimer: ReturnType<typeof setInterval> | null = null;
  let usageActive = false;
  // Timestamp (ms) of the most recent refresh attempt; gates the agent_end
  // refresh so it fires at most once per cooldown. Set when a fetch starts, so
  // a failing endpoint is also throttled, not just a successful one.
  let lastRefreshAt = 0;

  const usagePanelPublisher = createSidebarUsagePublisher(pi, "ollama-cloud:usage");

  async function refreshUsageStatus(ctx: ExtensionContext) {
    let data: UsageData | undefined;
    try {
      const apiKey = await getCloudApiKey(ctx);
      if (!apiKey) {
        usagePanelPublisher.withdraw();
        ctx.ui.setStatus(USAGE_STATUS_KEY, undefined);
        return;
      }
      lastRefreshAt = Date.now();
      data = await fetchUsage(apiKey);
    } catch {
      // Transient errors (undocumented endpoint, network) should not spam any
      // destination; withdraw the panel and clear the status, retrying on the
      // next refresh.
      data = undefined;
    }
    if (usageDisplay === "sidebar" && usagePanelPublisher.isCompatible() && data) {
      usagePanelPublisher.update({
        id: "ollama-cloud:usage",
        title: "Ollama Cloud",
        rows: usagePanelRows(data),
        defaults: { visible: true, after: "usage" },
      });
      ctx.ui.setStatus(USAGE_STATUS_KEY, undefined);
      return;
    }
    if (!data) {
      usagePanelPublisher.withdraw();
      ctx.ui.setStatus(USAGE_STATUS_KEY, undefined);
      return;
    }
    usagePanelPublisher.withdraw();
    ctx.ui.setStatus(USAGE_STATUS_KEY, formatUsageStatusColored(ctx.ui.theme, data));
  }

  function startUsageStatus(ctx: ExtensionContext) {
    if (usageActive) return;
    // The status bar and sidebar are TUI-only; skip the fetch and timer in
    // print/json/rpc.
    if (ctx.mode !== "tui") return;
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
    usagePanelPublisher.withdraw();
    ctx.ui.setStatus(USAGE_STATUS_KEY, undefined);
  }

  function isOllamaCloud(ctx: ExtensionContext): boolean {
    return ctx.model?.provider === "ollama-cloud";
  }
  pi.on("model_select", async (_event, ctx) => {
    if (usageDisplay !== "off" && isOllamaCloud(ctx)) {
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

  const MODE_LABEL: Record<UsageDisplayMode, string> = {
    sidebar: "sidebar panel (statusbar fallback without Pi Atelier)",
    statusbar: "statusbar",
    off: "off",
  };

  pi.registerCommand("ollama-usage-status", {
    description:
      "Set the Ollama Cloud usage display: sidebar, statusbar, or off. " +
      "Also accepts on/off/enable/disable. Without argument, toggles.",
    handler: async (args, ctx) => {
      const { mode, error } = resolveUsageStatusToggle(args, usageDisplay);
      if (error) {
        ctx.ui.notify(error, "error");
        return;
      }
      usageDisplay = mode;

      if (usageDisplay !== "off" && isOllamaCloud(ctx)) {
        startUsageStatus(ctx);
      } else {
        stopUsageStatus(ctx);
      }

      ctx.ui.notify(`Ollama Cloud usage display: ${MODE_LABEL[usageDisplay]}`, "info");
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
