import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStoredOllamaCloudKey, resolveOllamaCloudApiKey } from "../scripts/ollama-cloud-auth.ts";

describe("Ollama Cloud script credentials", () => {
  let authDir: string;
  let previousApiKey: string | undefined;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "pi-ollama-cloud-auth-"));
    previousApiKey = process.env.OLLAMA_API_KEY;
  });

  afterEach(() => {
    if (previousApiKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = previousApiKey;
    rmSync(authDir, { recursive: true, force: true });
  });

  function writeAuth(data: unknown): string {
    const authPath = join(authDir, "auth.json");
    writeFileSync(authPath, JSON.stringify(data));
    return authPath;
  }

  it("reads an ollama-cloud API-key credential", () => {
    const authPath = writeAuth({ "ollama-cloud": { type: "api_key", key: "stored-key" } });
    expect(readStoredOllamaCloudKey(authPath)).toBe("stored-key");
  });

  it("ignores malformed JSON and non-API-key credentials", () => {
    const authPath = join(authDir, "auth.json");
    writeFileSync(authPath, "{");
    expect(readStoredOllamaCloudKey(authPath)).toBeUndefined();

    expect(readStoredOllamaCloudKey(writeAuth({ "ollama-cloud": { type: "oauth", key: "not-an-api-key" } }))).toBe(
      undefined,
    );
  });

  it("prefers the stored credential over the environment variable", () => {
    process.env.OLLAMA_API_KEY = "environment-key";
    const authPath = writeAuth({ "ollama-cloud": { type: "api_key", key: "stored-key" } });
    expect(resolveOllamaCloudApiKey(authPath)).toEqual({ apiKey: "stored-key", source: "auth.json" });
  });

  it("falls back to the environment variable when no stored key exists", () => {
    process.env.OLLAMA_API_KEY = "environment-key";
    const authPath = writeAuth({});
    expect(resolveOllamaCloudApiKey(authPath)).toEqual({ apiKey: "environment-key", source: "OLLAMA_API_KEY" });
  });
});
