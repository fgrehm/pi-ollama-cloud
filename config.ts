/**
 * Configuration loader for pi-ollama-cloud.
 *
 * Reads settings from JSON config files with project-over-global precedence:
 *   - ~/.pi/agent/ollama-cloud.json (global / user-level)
 *   - .pi/ollama-cloud.json        (project-local, takes precedence)
 *
 * Environment variables serve as overrides above both config files:
 *   - PI_OLLAMA_WEB_TOOLS=0  disables web tool registration
 *
 * Example ollama-cloud.json:
 * ```json
 * {
 *   "webTools": false
 * }
 * ```
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// --- Types ---

export interface OllamaCloudConfig {
  /** When false, ollama_web_search and ollama_web_fetch tools are not registered. Default: true. */
  webTools?: boolean;
  /** When false, the footer usage status bar is not shown. Default: true. */
  usageStatus?: boolean;
}

// --- Defaults ---

const DEFAULT_CONFIG: OllamaCloudConfig = {
  webTools: true,
  usageStatus: true,
};

// --- Validation ---

/** Allowed config keys and their expected types for runtime validation. */
const CONFIG_SCHEMA: Record<keyof OllamaCloudConfig, "boolean"> = {
  webTools: "boolean",
  usageStatus: "boolean",
};

/**
 * Validate a parsed JSON object against the known schema.
 * Unknown keys are silently dropped; values with wrong types fall back to undefined.
 */
function sanitizeConfig(raw: Record<string, unknown>): OllamaCloudConfig {
  const out: OllamaCloudConfig = {};
  for (const [key, expectedType] of Object.entries(CONFIG_SCHEMA)) {
    const value = raw[key];
    if (typeof value === expectedType) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

// --- Loader ---

/**
 * Load configuration from JSON files.
 * Project-local config overrides global config.
 * Environment variables override both.
 */
export function loadConfig(cwd: string): OllamaCloudConfig {
  const globalPath = join(getAgentDir(), "ollama-cloud.json");
  const projectPath = join(cwd, ".pi", "ollama-cloud.json");

  let globalConfig: OllamaCloudConfig = {};
  let projectConfig: OllamaCloudConfig = {};

  // Load global config
  if (existsSync(globalPath)) {
    try {
      const content = readFileSync(globalPath, "utf-8");
      const parsed = JSON.parse(content);
      // Silently skip files that parse to null, arrays, or primitives —
      // malformed config should not crash the extension (defaults apply).
      if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
        globalConfig = sanitizeConfig(parsed as Record<string, unknown>);
      }
    } catch (err) {
      console.error(`[pi-ollama-cloud] Failed to load config from ${globalPath}: ${err}`);
    }
  }

  // Load project config
  if (existsSync(projectPath)) {
    try {
      const content = readFileSync(projectPath, "utf-8");
      const parsed = JSON.parse(content);
      // Same guard as global config: null/array/primitive parses are ignored.
      if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
        projectConfig = sanitizeConfig(parsed as Record<string, unknown>);
      }
    } catch (err) {
      console.error(`[pi-ollama-cloud] Failed to load config from ${projectPath}: ${err}`);
    }
  }

  // Merge with defaults: defaults < global < project
  const merged: OllamaCloudConfig = {
    ...DEFAULT_CONFIG,
    ...globalConfig,
    ...projectConfig,
  };

  // Environment variable overrides (only webTools for now)
  const envOverride = resolveWebToolsEnv();
  if (envOverride !== undefined) {
    merged.webTools = envOverride;
  }

  return merged;
}

/**
 * Resolve the PI_OLLAMA_WEB_TOOLS environment variable override.
 * Returns undefined when not set (no override),
 * true/false when explicitly set.
 */
export function resolveWebToolsEnv(): boolean | undefined {
  const raw = process.env.PI_OLLAMA_WEB_TOOLS;
  if (raw === undefined) return undefined;

  const lowered = raw.toLowerCase();
  if (["0", "false", "no", "off", ""].includes(lowered)) return false;
  // Treat any other non-empty value as "enabled"
  return true;
}
