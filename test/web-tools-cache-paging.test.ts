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

function createExecutor(cache: ReturnType<typeof createCache>) {
  const tools = new Map<string, RegisteredTool>();
  const pi = { registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool) };
  registerWebSearchTool(pi as any, cache);
  registerWebFetchTool(pi as any, cache);

  const ctx = {
    modelRegistry: { getApiKeyForProvider: vi.fn().mockResolvedValue("test-key") },
  };
  return (name: string, params: Record<string, unknown>) =>
    tools.get(name)!.execute("test-call", params, new AbortController().signal, undefined, ctx);
}

async function setupTools(cacheOptions: { maxPersistedEntryBytes?: number; maxCacheBytes?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ollama-web-tools-"));
  tempDirs.push(dir);
  const path = join(dir, "cache.json");
  const cache = createCache({ path, ...cacheOptions });
  const execute = createExecutor(cache);
  const executeFromFreshStore = () => createExecutor(createCache({ path, ...cacheOptions }));

  return { execute, executeFromFreshStore, path };
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
  it("reports a transport error clearly in search instead of status 0", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => {
      throw new Error("The operation was aborted due to timeout");
    });
    vi.stubGlobal("fetch", fetchMock);
    const { execute } = await setupTools();

    await expect(execute("ollama_web_search", { query: "q" })).rejects.toThrow("transport error");
    await expect(execute("ollama_web_search", { query: "q" })).rejects.not.toThrow(/status 0/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports malformed search result entries as a response-shape error", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ results: [null] }), { status: 200 }));
    const { execute } = await setupTools();

    await expect(execute("ollama_web_search", { query: "malformed" })).rejects.toThrow("unexpected response shape");
  });

  it("keeps oversized search content expandable in memory but refetches it from a fresh store", async () => {
    const content = "x".repeat(1000);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ results: [{ title: "Large", url: "https://example.com", content }] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { execute, executeFromFreshStore, path } = await setupTools({ maxPersistedEntryBytes: 256 });

    expect(output(await execute("ollama_web_search", { query: "large" }))).toContain("[truncated] Large");
    expect(createCache({ path, maxPersistedEntryBytes: 256 }).loadCache().searches).toEqual({});

    const expandedInMemory = output(await execute("ollama_web_search", { query: "large", expand: 1 }));
    expect(expandedInMemory).toContain(content);
    expect(expandedInMemory).toContain("# from cache");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const expandedFresh = output(await executeFromFreshStore()("ollama_web_search", { query: "large", expand: 1 }));
    expect(expandedFresh).toContain(content);
    expect(expandedFresh).toContain("# live query");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serves byte-evicted pages from memory and refetches them in a fresh store", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ title: "First", content: "a".repeat(4000), links: [] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ title: "Second", content: "b".repeat(4000), links: [] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ title: "Refetched", content: "c".repeat(4000), links: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const cacheOptions = { maxPersistedEntryBytes: 5000, maxCacheBytes: 5000 };
    const { execute, executeFromFreshStore, path } = await setupTools(cacheOptions);
    const urls = ["https://example.com/first", "https://example.com/second"];

    for (const url of urls) await execute("ollama_web_fetch", { url });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const persistedPages = createCache({ path, ...cacheOptions }).loadCache().pages;
    expect(Object.keys(persistedPages)).toHaveLength(1);
    const evictedUrl = urls.find((url) => persistedPages[url] === undefined);
    if (evictedUrl === undefined) throw new Error("Expected one page to be evicted by the byte budget.");

    const fromMemory = output(await execute("ollama_web_fetch", { url: evictedUrl, offset: 3000, full: true }));
    expect(fromMemory).toContain("# from cache");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const fromFreshStore = output(
      await executeFromFreshStore()("ollama_web_fetch", { url: evictedUrl, offset: 3000, full: true }),
    );
    expect(fromFreshStore).toContain("# live query");
    expect(fromFreshStore).toContain("c".repeat(1000));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

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
    await expect(execute("ollama_web_fetch", params)).rejects.toThrow("failure cached");
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

  it("does not negative-cache transport failures (timeout, abort, network)", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => {
      throw new Error("The operation was aborted due to timeout");
    });
    vi.stubGlobal("fetch", fetchMock);
    const { execute } = await setupTools();
    const params = { url: "https://example.com/slow" };

    await expect(execute("ollama_web_fetch", params)).rejects.toThrow("transport error");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The transport failure must not have been cached: the retry hits the API again.
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ title: "Recovered", content: "after retry", links: null }), { status: 200 }),
    );
    const retried = output(await execute("ollama_web_fetch", params));
    expect(retried).toContain("after retry");
    expect(retried).toContain("# live query");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not negative-cache server (5xx) failures", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const { execute } = await setupTools();
    const params = { url: "https://example.com/erroring" };

    await expect(execute("ollama_web_fetch", params)).rejects.toThrow("Ollama server error");
    await expect(execute("ollama_web_fetch", params)).rejects.toThrow("not cached");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not negative-cache unexpected response shapes", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ title: 42, content: "c", links: null }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { execute } = await setupTools();
    const params = { url: "https://example.com/shape" };

    await expect(execute("ollama_web_fetch", params)).rejects.toThrow("unexpected response shape");
    await expect(execute("ollama_web_fetch", params)).rejects.toThrow("unexpected response shape");
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
