import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type OllamaCloudApiKeySource = "auth.json" | "OLLAMA_API_KEY";

/** Read the stored Ollama Cloud API key from Pi's auth.json, if present. */
export function readStoredOllamaCloudKey(authPath = join(getAgentDir(), "auth.json")): string | undefined {
  if (!existsSync(authPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(authPath, "utf-8"));
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const entry = (parsed as Record<string, unknown>)["ollama-cloud"];
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const credential = entry as Record<string, unknown>;
    return credential.type === "api_key" && typeof credential.key === "string" ? credential.key : undefined;
  } catch {
    return undefined;
  }
}

/** Prefer Pi's stored credential, then fall back to the environment variable. */
export function resolveOllamaCloudApiKey(authPath = join(getAgentDir(), "auth.json")): {
  apiKey: string | undefined;
  source: OllamaCloudApiKeySource | undefined;
} {
  const storedKey = readStoredOllamaCloudKey(authPath);
  if (storedKey) return { apiKey: storedKey, source: "auth.json" };
  const envKey = process.env.OLLAMA_API_KEY;
  return envKey ? { apiKey: envKey, source: "OLLAMA_API_KEY" } : { apiKey: undefined, source: undefined };
}
