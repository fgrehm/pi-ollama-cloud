/**
 * Live smoke test for the Ollama Cloud web tools.
 *
 * Not shipped (not in package.json `files`). Run via `npm run smoke:web-tools`.
 *
 * Exercises the auth-resolution + live-request path end to end without loading
 * the full extension:
 *   1. Resolve a stored key by reading auth.json manually (simulating what
 *      ctx.modelRegistry.getApiKeyForProvider would return from stored creds).
 *   2. Build a fake ExtensionContext and call getCloudApiKey(ctx), which falls
 *      back to OLLAMA_API_KEY when no stored key is present (the #24 fix).
 *   3. Hit /api/web_search and /api/web_fetch via fetchJsonWithTimeout (15s).
 *
 * Gating: the CI step runs only when secrets.OLLAMA_CLOUD_API_KEY is set, and
 * exports it as OLLAMA_API_KEY. Locally, set OLLAMA_API_KEY or have an
 * ollama-cloud entry in auth.json. Exits non-zero on any failure, including
 * when no key is resolvable (so a broken resolution path is not masked).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionContext, getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { OLLAMA_BASE } from "../models.ts";
import { fetchJsonWithTimeout, getCloudApiKey } from "../utils.ts";

const TIMEOUT_MS = 15000;

interface SearchResponse {
  results: Array<{ title: string; url: string; content: string }>;
}

interface FetchResponse {
  title: string;
  content: string;
  links: string[];
}

/** Read the stored ollama-cloud API key from auth.json, or undefined. */
function readStoredOllamaCloudKey(): string | undefined {
  const authPath = join(getAgentDir(), "auth.json");
  if (!existsSync(authPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf-8"));
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const entry = (parsed as Record<string, unknown>)["ollama-cloud"];
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const key = (entry as Record<string, unknown>).key;
    return typeof key === "string" ? key : undefined;
  } catch {
    return undefined;
  }
}

/** Fake ExtensionContext whose modelRegistry returns the given stored key. */
function fakeCtx(storedKey: string | undefined): Pick<ExtensionContext, "modelRegistry"> {
  return {
    modelRegistry: {
      getApiKeyForProvider: async (_provider: string) => storedKey,
    } as unknown as ModelRegistry,
  };
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

async function main() {
  const storedKey = readStoredOllamaCloudKey();
  const apiKey = await getCloudApiKey(fakeCtx(storedKey));
  if (!apiKey) {
    fail("no Ollama Cloud API key resolved. Set OLLAMA_API_KEY or add an ollama-cloud entry to auth.json.");
  }
  console.log(`PASS: getCloudApiKey resolved a key (via ${storedKey ? "auth.json" : "OLLAMA_API_KEY env"}).`);

  // --- web_search ---
  const searchRes = await fetchJsonWithTimeout<SearchResponse>(
    `${OLLAMA_BASE}/api/web_search`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "Ollama Cloud", max_results: 3 }),
    },
    TIMEOUT_MS,
  );
  if (!searchRes.ok) fail(`web_search failed (status ${searchRes.status}): ${searchRes.error}`);
  if (!searchRes.data || !Array.isArray(searchRes.data.results)) {
    fail("web_search returned an unexpected response shape.");
  }
  console.log(`PASS: web_search returned ${searchRes.data?.results.length ?? 0} results.`);

  // --- web_fetch ---
  const fetchRes = await fetchJsonWithTimeout<FetchResponse>(
    `${OLLAMA_BASE}/api/web_fetch`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://ollama.com" }),
    },
    TIMEOUT_MS,
  );
  if (!fetchRes.ok) fail(`web_fetch failed (status ${fetchRes.status}): ${fetchRes.error}`);
  if (!fetchRes.data || typeof fetchRes.data.content !== "string") {
    fail("web_fetch returned an unexpected response shape.");
  }
  console.log(`PASS: web_fetch returned title "${fetchRes.data?.title ?? ""}" with content.`);

  console.log("All web tools smoke checks passed.");
}

await main();
