import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCloudApiKey } from "../web-tools.ts";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

// Minimal stub: only `getApiKeyForProvider` is exercised. The real
// ModelRegistry reads auth.json and resolves `$VAR`/`!command` via pi's
// resolveConfigValue; here we stub its return to drive getCloudApiKey's
// fallback logic (the only behavior this extension owns).
function stubRegistry(key: string | undefined, opts: { throw?: boolean } = {}): ModelRegistry {
  return {
    getApiKeyForProvider: async () => {
      if (opts.throw) throw new Error("registry boom");
      return key;
    },
  } as unknown as ModelRegistry;
}

const ENV_BACKUP: Record<string, string | undefined> = {};

beforeEach(() => {
  ENV_BACKUP.OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_API_KEY;
});

afterEach(() => {
  if (ENV_BACKUP.OLLAMA_API_KEY === undefined) delete process.env.OLLAMA_API_KEY;
  else process.env.OLLAMA_API_KEY = ENV_BACKUP.OLLAMA_API_KEY;
});

describe("getCloudApiKey", () => {
  it("returns the key resolved by the model registry", async () => {
    expect(await getCloudApiKey(stubRegistry("sk-from-auth-json"))).toBe("sk-from-auth-json");
  });

  it("falls back to OLLAMA_API_KEY when the registry returns undefined", async () => {
    process.env.OLLAMA_API_KEY = "env-fallback";
    expect(await getCloudApiKey(stubRegistry(undefined))).toBe("env-fallback");
  });

  it("falls back to OLLAMA_API_KEY when the registry returns an empty string", async () => {
    process.env.OLLAMA_API_KEY = "env-fallback";
    expect(await getCloudApiKey(stubRegistry(""))).toBe("env-fallback");
  });

  it("falls back to OLLAMA_API_KEY when the registry throws", async () => {
    process.env.OLLAMA_API_KEY = "env-fallback";
    expect(await getCloudApiKey(stubRegistry(undefined, { throw: true }))).toBe("env-fallback");
  });

  it("returns undefined when neither registry nor env has a key", async () => {
    expect(await getCloudApiKey(stubRegistry(undefined))).toBeUndefined();
  });

  it("prefers the registry key over OLLAMA_API_KEY", async () => {
    process.env.OLLAMA_API_KEY = "env-fallback";
    expect(await getCloudApiKey(stubRegistry("sk-from-auth-json"))).toBe("sk-from-auth-json");
  });
});
