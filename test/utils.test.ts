import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCloudApiKey, httpError } from "../utils.ts";

// --- Helpers ---

/**
 * Build a fake ExtensionContext whose modelRegistry.getApiKeyForProvider
 * returns the given key.
 */
function fakeCtx(storedKey: string | undefined): Pick<ExtensionContext, "modelRegistry"> {
  return {
    modelRegistry: {
      getApiKeyForProvider: async (_provider: string) => storedKey,
    } as unknown as ModelRegistry,
  };
}

// ============================================================================
// getCloudApiKey
// ============================================================================

describe("getCloudApiKey", () => {
  const originalEnv = process.env.OLLAMA_API_KEY;

  beforeEach(() => {
    delete process.env.OLLAMA_API_KEY;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = originalEnv;
  });

  it("returns the stored key when getApiKeyForProvider resolves one", async () => {
    const apiKey = await getCloudApiKey(fakeCtx("stored-key"));
    expect(apiKey).toBe("stored-key");
  });

  it("falls back to OLLAMA_API_KEY env var when no stored key is resolved (#24 regression)", async () => {
    process.env.OLLAMA_API_KEY = "env-key";
    const apiKey = await getCloudApiKey(fakeCtx(undefined));
    expect(apiKey).toBe("env-key");
  });

  it("returns undefined when neither a stored key nor the env var is set", async () => {
    const apiKey = await getCloudApiKey(fakeCtx(undefined));
    expect(apiKey).toBeUndefined();
  });

  it("prefers the stored key over the OLLAMA_API_KEY env var", async () => {
    process.env.OLLAMA_API_KEY = "env-key";
    const apiKey = await getCloudApiKey(fakeCtx("stored-key"));
    expect(apiKey).toBe("stored-key");
  });
});

// ============================================================================
// httpError
// ============================================================================

describe("httpError", () => {
  it("throws an auth error on 401", () => {
    expect(() => httpError("usage", 401)).toThrow(/authentication error/);
  });

  it("throws an auth error on 403", () => {
    expect(() => httpError("usage", 403)).toThrow(/authentication error/);
  });

  it("throws a rate-limit error on 429", () => {
    expect(() => httpError("usage", 429)).toThrow(/rate limited/);
  });

  it("throws a server error on 5xx", () => {
    expect(() => httpError("usage", 500)).toThrow(/server error/);
  });

  it("throws an unexpected-response error on other statuses", () => {
    expect(() => httpError("usage", 400)).toThrow(/unexpected response/);
  });

  it("includes the operation name in the message", () => {
    expect(() => httpError("search", 500)).toThrow(/search failed/);
  });

  it("includes the server error body when present", () => {
    expect(() => httpError("usage", 400, "bad request")).toThrow(/bad request/);
  });
});
