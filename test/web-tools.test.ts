import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getCloudApiKey, isFetchResponse, isSearchResponse } from "../web-tools.ts";

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

// --- Tests ---

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
// isFetchResponse
// ============================================================================

describe("isFetchResponse", () => {
  it("accepts a response with a links array", () => {
    expect(isFetchResponse({ title: "t", content: "c", links: ["https://a"] })).toBe(true);
  });

  it("accepts a response with null links (pages with no extractable links)", () => {
    expect(isFetchResponse({ title: "t", content: "c", links: null })).toBe(true);
  });

  it("rejects a response missing title", () => {
    expect(isFetchResponse({ content: "c", links: [] })).toBe(false);
  });

  it("rejects a response missing content", () => {
    expect(isFetchResponse({ title: "t", links: [] })).toBe(false);
  });

  it("rejects a response whose links is neither an array nor null", () => {
    expect(isFetchResponse({ title: "t", content: "c", links: "nope" })).toBe(false);
  });

  it("rejects a links array containing a non-string entry", () => {
    expect(isFetchResponse({ title: "t", content: "c", links: ["https://a", 42] })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isFetchResponse(null)).toBe(false);
    expect(isFetchResponse("string")).toBe(false);
    expect(isFetchResponse(42)).toBe(false);
  });
});

// ============================================================================
// isSearchResponse
// ============================================================================

describe("isSearchResponse", () => {
  it("accepts a response with a results array", () => {
    expect(isSearchResponse({ results: [{ title: "t", url: "u", content: "c" }] })).toBe(true);
  });

  it("rejects a response without results", () => {
    expect(isSearchResponse({})).toBe(false);
  });

  it("rejects a results entry missing a field", () => {
    expect(isSearchResponse({ results: [{ title: "t", url: "u" }] })).toBe(false);
    expect(isSearchResponse({ results: [{ title: "t", content: "c" }] })).toBe(false);
    expect(isSearchResponse({ results: [{ url: "u", content: "c" }] })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isSearchResponse(null)).toBe(false);
    expect(isSearchResponse("string")).toBe(false);
  });
});