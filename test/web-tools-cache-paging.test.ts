import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type RegisteredTool = {
  name: string;
  execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text?: string }> }>;
};

const tempDirs: string[] = [];

async function setupTools() {
  const dir = mkdtempSync(join(tmpdir(), "ollama-web-tools-"));
  tempDirs.push(dir);
  vi.stubEnv("PI_OLLAMA_SEARCH_CACHE_PATH", join(dir, "cache.json"));
  vi.stubEnv("PI_OLLAMA_SEARCH_SNIPPET_CHARS", "500");
  vi.stubEnv("PI_OLLAMA_SEARCH_CHUNK_CHARS", "3000");
  vi.resetModules();

  const { registerWebFetchTool, registerWebSearchTool } = await import("../web-tools.ts");
  const tools = new Map<string, RegisteredTool>();
  const pi = { registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool) };
  registerWebSearchTool(pi as any);
  registerWebFetchTool(pi as any);

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
});
