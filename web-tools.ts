/**
 * Ollama Cloud web tools: ollama_web_search and ollama_web_fetch.
 *
 * Self-contained module. Depends on:
 *   - models.ts       - only for OLLAMA_BASE URL constant
 *   - pi-coding-agent - ExtensionAPI, keyHint, truncateToVisualLines
 *   - pi-tui          - Text, truncateToWidth
 * Does NOT depend on provider registration or model fetching internals.
 *
 * Auth note: pi removed `AuthStorage` from its public exports in 0.80.8 and
 * added `readStoredCredential` in the same release. A static named import of
 * either symbol is a hard link-error on the other version range, so we use a
 * namespace import and feature-detect at runtime to stay compatible with
 * pi 0.74.0 through 0.80.10+.
 *
 * `readStoredCredential` returns the raw stored credential WITHOUT resolving
 * config-value references (env vars, `!command`). On pi <= 0.80.7 the
 * `AuthStorage.getApiKey()` path resolved them internally via pi's private
 * `resolveConfigValue`; on pi >= 0.80.8 that path is gone and `resolveConfigValue`
 * is NOT a public export, so we port pi's 0.80.8 resolver semantics locally
 * (`resolveCredentialKey`) and run it on the `readStoredCredential` branch.
 * The `AuthStorage` branch is unchanged and delegates to pi. See issue #38.
 *
 * Limitation: on pi >= 0.80.8, OAuth credentials (`type: "oauth"`) in auth.json
 * are NOT supported by the `readStoredCredential` path (only `type: "api_key"`),
 * because `AuthStorage`'s OAuth refresh is gone. Use a literal api_key or the
 * `OLLAMA_API_KEY` env var for OAuth providers. (#38)
 */

import { execSync, spawnSync } from "node:child_process";
import * as piAgent from "@earendil-works/pi-coding-agent";
import { type ExtensionAPI, keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { OLLAMA_BASE } from "./models.ts";

// --- Types ---

interface SearchResponse {
  results: Array<{
    title: string;
    url: string;
    content: string;
  }>;
}

interface FetchResponse {
  title: string;
  content: string;
  links: string[];
}

// --- Helpers ---

// pi exports `readStoredCredential` (>= 0.80.8) and `AuthStorage` (<= 0.80.7);
// only one is present on any given version. Probe the namespace at runtime
// rather than importing either by name so the extension loads everywhere.
type PiAuthModule = {
  AuthStorage?: {
    new (): {
      create(): {
        getApiKey(provider: string): Promise<string | undefined>;
      };
    };
  };
  readStoredCredential?: (provider: string) => { type: string; key?: string } | undefined;
  // getShellConfig is publicly exported on all pi versions; feature-detected off
  // the namespace so we never add a load-time static-import dependency.
  getShellConfig?: () => { shell: string; args: string[] };
};

// --- Config-value resolver (port of pi 0.80.8 resolveConfigValue semantics) ---
//
// pi's resolveConfigValue is internal (dist/core/resolve-config-value.js) and
// not re-exported from the public entrypoint on any version, so the extension
// cannot import it. This faithful port mirrors pi 0.80.8 exactly so the
// `readStoredCredential` path (0.80.8+) behaves identically to what
// `AuthStorage.getApiKey()` did on 0.74.0-0.80.7. See issue #38.

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

// Cache for shell command results (process lifetime). Mirrors pi's
// `commandResultCache` in resolve-config-value.ts. Cleared in tests via
// `__clearCommandCache`.
const commandResultCache = new Map<string, string | undefined>();

function appendLiteral(parts: TemplatePart[], value: string): void {
  if (!value) return;
  const prev = parts[parts.length - 1];
  if (prev?.type === "literal") {
    prev.value += value;
    return;
  }
  parts.push({ type: "literal", value });
}

// Port of pi's parseConfigValueTemplate: `$VAR`, `${VAR}`, `$$`/`$!` escapes,
// otherwise literal.
function parseConfigValueTemplate(config: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let index = 0;
  while (index < config.length) {
    const dollarIndex = config.indexOf("$", index);
    if (dollarIndex < 0) {
      appendLiteral(parts, config.slice(index));
      break;
    }
    appendLiteral(parts, config.slice(index, dollarIndex));
    const nextChar = config[dollarIndex + 1];

    if (nextChar === "$" || nextChar === "!") {
      appendLiteral(parts, nextChar);
      index = dollarIndex + 2;
      continue;
    }
    if (nextChar === "{") {
      const endIndex = config.indexOf("}", dollarIndex + 2);
      if (endIndex < 0) {
        appendLiteral(parts, "$");
        index = dollarIndex + 1;
        continue;
      }
      const name = config.slice(dollarIndex + 2, endIndex);
      if (ENV_VAR_NAME_RE.test(name)) parts.push({ type: "env", name });
      else appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
      index = endIndex + 1;
      continue;
    }
    const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
    if (match) {
      parts.push({ type: "env", name: match[0] });
      index = dollarIndex + 1 + match[0].length;
      continue;
    }
    appendLiteral(parts, "$");
    index = dollarIndex + 1;
  }
  return parts;
}

function resolveTemplate(parts: TemplatePart[]): string | undefined {
  let resolved = "";
  for (const part of parts) {
    if (part.type === "literal") {
      resolved += part.value;
      continue;
    }
    const envValue = process.env[part.name];
    if (envValue === undefined) return undefined; // missing env var => undefined (env fallback reachable)
    resolved += envValue;
  }
  return resolved;
}

/** Resolve a raw auth.json key the way pi's resolveConfigValue does on 0.80.8+,
 *  without importing the non-public internal. Exported for unit testing. */
export function resolveCredentialKey(rawKey: string): string | undefined {
  if (!rawKey) return undefined;
  if (rawKey.startsWith("!")) return executeCommand(rawKey);
  return resolveTemplate(parseConfigValueTemplate(rawKey));
}

// Mirrors pi's executeCommandUncached (resolve-config-value.ts) exactly:
//  win32: getShellConfig (bash) with execSync fallback; unix: execSync.
function executeCommandUncached(command: string): string | undefined {
  const mod = piAgent as PiAuthModule & typeof piAgent;
  if (process.platform === "win32" && typeof mod.getShellConfig === "function") {
    try {
      const { shell, args } = mod.getShellConfig();
      const r = spawnSync(shell, [...args, command], {
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
        windowsHide: true,
      });
      if (!r.error && r.status === 0) return (r.stdout ?? "").trim() || undefined;
      // executed-but-failed -> fall through to execSync, like pi.
    } catch {
      // getShellConfig threw (e.g. no bash on win32) -> fall through to execSync.
    }
  }
  try {
    const out = execSync(command, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

function executeCommand(commandConfig: string): string | undefined {
  if (commandResultCache.has(commandConfig)) return commandResultCache.get(commandConfig);
  const result = executeCommandUncached(commandConfig.slice(1));
  commandResultCache.set(commandConfig, result);
  return result;
}

/** Clear the shell-command cache. Exported for tests. */
export function __clearCommandCache(): void {
  commandResultCache.clear();
}

// Test seam: when `_authOverridesActive` is true, the stored override values (which
// may be undefined) fully replace the namespace-detected accessors. This lets tests
// exercise the readStoredCredential path even on pi 0.74.0 (where mod.AuthStorage
// is present and would otherwise read the real auth.json).
let _testReadStoredCredential: PiAuthModule["readStoredCredential"] | undefined;
let _testAuthStorage: PiAuthModule["AuthStorage"] | undefined;
let _authOverridesActive = false;

/** @internal Test seam. Passing `undefined` for an accessor disables it. */
export function __setTestAuthOverrides(overrides: {
  readStoredCredential?: PiAuthModule["readStoredCredential"];
  AuthStorage?: PiAuthModule["AuthStorage"];
}) {
  _testReadStoredCredential = overrides.readStoredCredential;
  _testAuthStorage = overrides.AuthStorage;
  _authOverridesActive = true;
}

/** @internal Reset the test seam to use the real namespace accessors. */
export function __clearTestAuthOverrides() {
  _testReadStoredCredential = undefined;
  _testAuthStorage = undefined;
  _authOverridesActive = false;
}

export async function getCloudApiKey(): Promise<string | undefined> {
  const mod = piAgent as PiAuthModule & typeof piAgent;
  const readStoredCredential = _authOverridesActive ? _testReadStoredCredential : mod.readStoredCredential;
  const AuthStorage = _authOverridesActive ? _testAuthStorage : mod.AuthStorage;

  // pi >= 0.80.8: readStoredCredential (raw read — resolve locally, 0.80.8 semantics)
  if (typeof readStoredCredential === "function") {
    try {
      const cred = readStoredCredential("ollama-cloud");
      if (cred && cred.type === "api_key" && cred.key) {
        const resolved = resolveCredentialKey(cred.key);
        if (resolved) return resolved;
        // unresolved (missing env var / failed command) -> fall through to AuthStorage / env
      }
      // OAuth (type !== "api_key") falls through — see limitation in file header. (#38)
    } catch (e) {
      console.debug("ollama-cloud: readStoredCredential probe failed:", e);
    }
  }

  // pi <= 0.80.7: AuthStorage still exported (resolves env vars, $VAR, !command, OAuth refresh).
  if (AuthStorage) {
    try {
      const authStorage = AuthStorage.create();
      const key = await authStorage.getApiKey("ollama-cloud");
      if (key) return key;
    } catch (e) {
      console.debug("ollama-cloud: AuthStorage probe failed:", e);
    }
  }

  // pi-ai doesn't know the "ollama-cloud" provider id, so neither auth path
  // sees OLLAMA_API_KEY — keep the explicit env fallback for both. (#24/#48)
  return process.env.OLLAMA_API_KEY;
}

function noApiKeyError() {
  return {
    content: [
      {
        type: "text" as const,
        text: "Error: No Ollama Cloud API key configured. Set OLLAMA_API_KEY or add to auth.json.",
      },
    ],
    isError: true,
  };
}

const PREVIEW_LINES = 8;

/**
 * Build a renderResult handler that shows a truncated preview when collapsed
 * and the full output when expanded. Follows the bash tool pattern.
 */
function createRenderResult() {
  return (
    result: { content: Array<{ type: string; text: string }>; isError?: boolean },
    options: { expanded: boolean; isPartial: boolean },
    theme: import("@earendil-works/pi-coding-agent").Theme,
    context: {
      invalidate: () => void;
      lastComponent: import("@earendil-works/pi-tui").Component | undefined;
      state: { cachedWidth?: number; cachedLines?: string[]; cachedSkipped?: number };
    },
  ) => {
    const state = context.state;
    const output = result.content
      .map((c) => c.text)
      .join("")
      .trim();
    const styledOutput = output
      .split("\n")
      .map((line: string) => theme.fg("toolOutput", line))
      .join("\n");

    if (options.expanded || result.isError) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(result.isError ? styledOutput : `\n${styledOutput}`);
      return text;
    }

    return {
      render: (width: number) => {
        if (state.cachedWidth !== width) {
          const preview = truncateToVisualLines(styledOutput, PREVIEW_LINES, width);
          state.cachedLines = preview.visualLines;
          state.cachedSkipped = preview.skippedCount;
          state.cachedWidth = width;
        }
        if (state.cachedSkipped && state.cachedSkipped > 0) {
          const hint =
            theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
            ` ${keyHint("app.tools.expand", "to expand")})`;
          return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
        }
        return ["", ...(state.cachedLines ?? [])];
      },
      invalidate: () => {
        state.cachedWidth = undefined;
        state.cachedLines = undefined;
        state.cachedSkipped = undefined;
      },
    };
  };
}

// --- Registrations ---

export function registerWebSearchTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ollama_web_search",
    label: "Ollama Web Search",
    description:
      "Search the web for real-time information using Ollama Cloud's web search API. " +
      "Returns relevant results with titles, URLs, and content snippets. " +
      "Requires an Ollama Cloud API key.",
    parameters: Type.Object({
      query: Type.String({ description: "The search query to execute" }),
      max_results: Type.Optional(
        Type.Integer({
          description: "Maximum number of search results to return (default: 5, max: 10)",
          default: 5,
          minimum: 1,
          maximum: 10,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const apiKey = await getCloudApiKey();
      if (!apiKey) return noApiKeyError();

      try {
        const res = await fetch(`${OLLAMA_BASE}/api/web_search`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: params.query,
            max_results: params.max_results ?? 5,
          }),
          signal,
        });

        if (!res.ok) {
          const errorText = await res.text().catch(() => "");
          if (res.status === 401 || res.status === 403) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    "Ollama Cloud search failed: authentication error. " +
                    "Check your API key in OLLAMA_API_KEY or auth.json.",
                },
              ],
              isError: true,
            };
          }
          if (res.status === 429) {
            return {
              content: [{ type: "text", text: "Ollama Cloud search failed: rate limited. Try again shortly." }],
              isError: true,
            };
          }
          return {
            content: [
              { type: "text", text: `Search API error (status ${res.status}): ${errorText || res.statusText}` },
            ],
            isError: true,
          };
        }

        const data = (await res.json()) as SearchResponse;
        const formatted = data.results
          .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.content}`)
          .join("\n\n");

        return {
          content: [{ type: "text", text: formatted || "No results found." }],
          details: { results: data.results },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Web search failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
    renderCall(args, theme, _context) {
      const display = args.query ? `ollama_web_search("${args.query}")` : "ollama_web_search";
      return new Text(theme.fg("toolTitle", display), 0, 0);
    },
    renderResult: createRenderResult(),
  });
}

export function registerWebFetchTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ollama_web_fetch",
    label: "Ollama Web Fetch",
    description:
      "Fetch and extract text content from a web page URL using Ollama Cloud's web fetch API. " +
      "Returns the page title, main content, and links found on the page. " +
      "Requires an Ollama Cloud API key.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch and extract content from", format: "uri" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const apiKey = await getCloudApiKey();
      if (!apiKey) return noApiKeyError();

      try {
        const res = await fetch(`${OLLAMA_BASE}/api/web_fetch`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url: params.url }),
          signal,
        });

        if (!res.ok) {
          const errorText = await res.text().catch(() => "");
          if (res.status === 401 || res.status === 403) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    "Ollama Cloud fetch failed: authentication error. " +
                    "Check your API key in OLLAMA_API_KEY or auth.json.",
                },
              ],
              isError: true,
            };
          }
          if (res.status === 429) {
            return {
              content: [{ type: "text", text: "Ollama Cloud fetch failed: rate limited. Try again shortly." }],
              isError: true,
            };
          }
          return {
            content: [{ type: "text", text: `Fetch API error (status ${res.status}): ${errorText || res.statusText}` }],
            isError: true,
          };
        }

        const data = (await res.json()) as FetchResponse;
        const formatted = [
          `Title: ${data.title}`,
          "",
          "Content:",
          data.content,
          "",
          `Links found: ${data.links?.length ?? 0}`,
          ...(data.links?.slice(0, 10).map((l) => `  - ${l}`) ?? []),
        ].join("\n");

        return {
          content: [{ type: "text", text: formatted }],
          details: { title: data.title, content: data.content, links: data.links },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Web fetch failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
    renderCall(args, theme, _context) {
      const display = args.url ? `ollama_web_fetch("${args.url}")` : "ollama_web_fetch";
      return new Text(theme.fg("toolTitle", display), 0, 0);
    },
    renderResult: createRenderResult(),
  });
}
