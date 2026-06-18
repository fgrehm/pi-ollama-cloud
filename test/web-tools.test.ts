import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { getCloudApiKey } from "../web-tools.ts";

/**
 * getCloudApiKey() resolves the API key for the ollama-cloud provider.
 *
 * Regressions covered:
 *   - The `?? process.env.OLLAMA_API_KEY` fallback was dead code because
 *     `authStorage.getApiKey()` is async and the original code did not
 *     await it (issue #24, fixed in PR #26).
 */

const ENV_KEY = "env-fallback-key";

describe("getCloudApiKey", () => {
  const originalEnvKey = process.env.OLLAMA_API_KEY;

  afterEach(() => {
    if (originalEnvKey === undefined) {
      delete process.env.OLLAMA_API_KEY;
    } else {
      process.env.OLLAMA_API_KEY = originalEnvKey;
    }
  });

  it("returns the auth.json api_key when configured", async () => {
    const authStorage = AuthStorage.inMemory({
      "ollama-cloud": { type: "api_key", key: "stored-key" },
    });
    process.env.OLLAMA_API_KEY = ENV_KEY;

    const key = await getCloudApiKey(authStorage);
    expect(key).toBe("stored-key");
  });

  it("falls back to OLLAMA_API_KEY env var when auth.json has no ollama-cloud entry", async () => {
    // Regression test for issue #24: without `await`, the returned Promise
    // is always truthy and the `??` fallback is never evaluated.
    const authStorage = AuthStorage.inMemory({});
    process.env.OLLAMA_API_KEY = ENV_KEY;

    const key = await getCloudApiKey(authStorage);
    expect(key).toBe(ENV_KEY);
  });

  it("returns undefined when neither auth.json nor env var is set", async () => {
    const authStorage = AuthStorage.inMemory({});
    delete process.env.OLLAMA_API_KEY;

    const key = await getCloudApiKey(authStorage);
    expect(key).toBeUndefined();
  });

  it("prefers auth.json api_key over the OLLAMA_API_KEY env var", async () => {
    const authStorage = AuthStorage.inMemory({
      "ollama-cloud": { type: "api_key", key: "stored-key" },
    });
    process.env.OLLAMA_API_KEY = ENV_KEY;

    const key = await getCloudApiKey(authStorage);
    expect(key).toBe("stored-key");
  });
});
