import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCache } from "../cache.ts";
import { registerWebFetchTool, registerWebSearchTool } from "../web-tools.ts";

type RegisteredTool = {
  name: string;
  execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text?: string }> }>;
};

const tempDirs: string[] = [];

async function setupTools() {
  const dir = mkdtempSync(join(tmpdir(), "ollama-web-tools-"));
  tempDirs.push(dir);
  const cache = createCache({ path: join(dir, "cache.json") });
  const tools = new Map<string, RegisteredTool>();
  const pi = { registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool) };
  registerWebSearchTool(pi as any, cache);
  registerWebFetchTool(pi as any, cache);

  const ctx = {
    modelRegistry: { getApiKeyForProvider: vi.fn().mockResolvedValue("test-key") },
  };
  const execute = (name: string, params: Record<string, unknown>) =>
    tools.get(name)!.execute("test-call", params, new AbortController().signal, undefined, ctx);

  return { execute };
}

function output(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("web tool cache and paging", () => {
  it("expands a cached search result without a second API call", async () => {
    const fullContent = "x".repeat(600);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ results: [{ title: "Result", url: "https://example.com", content: fullContent }] }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { execute } = await setupTools();

    const search = output(await execute("ollama_web_search", { query: "test" }));
    expect(search).toContain("[truncated] Result");
    expect(search).toContain("# live query");

    const expanded = output(await execute("ollama_web_search", { query: "test", expand: 1 }));
    expect(expanded).toContain(fullContent);
    expect(expanded).toContain("# from cache");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads a cached page with offset/full without a second API call", async () => {
    const pageContent = `${"a".repeat(3000)}${"b".repeat(4000)}`;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ title: "Long page", content: pageContent, links: ["https://example.com/next"] }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { execute } = await setupTools();

    const firstPage = output(await execute("ollama_web_fetch", { url: "https://example.com" }));
    expect(firstPage).toContain("Chars 1-3000 of 7000");
    expect(firstPage).toContain("offset=3000");
    expect(firstPage).toContain("# live query");

    const remainder = output(
      await execute("ollama_web_fetch", { url: "https://example.com", offset: 3000, full: true }),
    );
    expect(remainder).toContain("Chars 3001-7000 of 7000");
    expect(remainder).toContain("b".repeat(4000));
    expect(remainder).not.toContain("Continue:");
    expect(remainder).toContain("# from cache");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("negative-caches a failed page fetch", async () => {
    const fetchMock = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const { execute } = await setupTools();
    const params = { url: "https://example.com/missing" };

    await expect(execute("ollama_web_fetch", params)).rejects.toThrow("live request failed");
    await expect(execute("ollama_web_fetch", params)).rejects.toThrow("from cache");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not negative-cache auth failures and points at the API key", async () => {
    const fetchMock = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const { execute } = await setupTools();
    const params = { url: "https://example.com/secret" };

    await expect(execute("ollama_web_fetch", params)).rejects.toThrow("authentication error");
    await expect(execute("ollama_web_fetch", params)).rejects.toThrow("OLLAMA_API_KEY");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not negative-cache rate-limit failures", async () => {
    const fetchMock = vi.fn(async () => new Response("slow down", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const { execute } = await setupTools();
    const params = { url: "https://example.com/busy" };

    await expect(execute("ollama_web_fetch", params)).rejects.toThrow("rate limited");
    await expect(execute("ollama_web_fetch", params)).rejects.toThrow("try again shortly");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refresh=true bypasses the cached search and replaces the entry", async () => {
    let version = 1;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [{ title: "Result", url: "https://example.com", content: `v${version}` }],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { execute } = await setupTools();

    expect(output(await execute("ollama_web_search", { query: "test" }))).toContain("v1");
    version = 2;
    const refreshed = output(await execute("ollama_web_search", { query: "test", refresh: true }));
    expect(refreshed).toContain("v2");
    expect(refreshed).toContain("# live query");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The fresh result replaced the cache entry: a normal call now serves v2 from cache.
    const cached = output(await execute("ollama_web_search", { query: "test" }));
    expect(cached).toContain("v2");
    expect(cached).toContain("# from cache");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refresh=true forces a live retry of a cached failure", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ title: "Back", content: "recovered", links: null }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { execute } = await setupTools();

    // Seed a cached failure (404), then recover.
    fetchMock.mockImplementationOnce(async () => new Response("not found", { status: 404 }));
    const params = { url: "https://example.com/flaky" };
    await expect(execute("ollama_web_fetch", params)).rejects.toThrow("live request failed");
    await expect(execute("ollama_web_fetch", params)).rejects.toThrow("refresh=true");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const retried = output(await execute("ollama_web_fetch", { ...params, refresh: true }));
    expect(retried).toContain("recovered");
    expect(retried).toContain("# live query");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
