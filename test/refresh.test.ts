import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelsPublication, RefreshModelsContext } from "@earendil-works/pi-ai";
import { GENERATED_MODELS } from "../models.generated.ts";
import { refreshOllamaCatalog } from "../models.ts";

// --- Helpers ---

const originalFetch = globalThis.fetch;

// The publish stub needs a concrete call signature (not vi.fn's default
// `Procedure | Constructable` union) to satisfy RefreshModelsContext.
type Publish = (publication: ModelsPublication) => Promise<boolean>;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A minimal pi-ai Model-shaped stored entry (provider/api/baseUrl filled in). */
function makeStoredModel(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32768,
    provider: "ollama-cloud",
    api: "openai-completions",
    baseUrl: "https://ollama.com/v1",
  };
}

function makeContext(overrides: {
  allowNetwork?: boolean;
  force?: boolean;
  stored?: RefreshModelsContext["stored"];
  publish?: ReturnType<typeof vi.fn<Publish>>;
} = {}) {
  const controller = new AbortController();
  const publish = overrides.publish ?? vi.fn<Publish>().mockResolvedValue(true);
  const context: RefreshModelsContext = {
    allowNetwork: overrides.allowNetwork ?? true,
    force: overrides.force,
    signal: controller.signal,
    stored: overrides.stored,
    publish,
  };
  return { context, publish, controller };
}

/** Fetch mock for a successful network refresh: /v1/models + per-model /api/show. */
function mockLiveApi() {
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/v1/models")) {
      return new Response(
        JSON.stringify({ data: [{ id: "thinking-model" }, { id: "plain-model" }] }),
        { status: 200 },
      );
    }
    // POST /api/show — echo capabilities based on the requested model id.
    const body = JSON.parse(String(init?.body)) as { model: string };
    const capabilities = body.model === "thinking-model" ? ["tools", "thinking"] : ["tools"];
    return new Response(JSON.stringify({ capabilities, model_info: {} }), { status: 200 });
  };
}

// ============================================================================
// Restore phase (allowNetwork: false)
// ============================================================================

describe("refreshOllamaCatalog restore phase", () => {
  it("returns GENERATED_MODELS when no stored entry exists, and never publishes", async () => {
    const { context, publish } = makeContext({ allowNetwork: false, stored: undefined });
    const result = await refreshOllamaCatalog(context);
    expect(result).toEqual(GENERATED_MODELS);
    expect(result.length).toBeGreaterThan(0); // never returns []
    expect(publish).not.toHaveBeenCalled();
  });

  it("returns the stored models when one exists, without persisting", async () => {
    const storedModels = [makeStoredModel("stored-a"), makeStoredModel("stored-b")];
    const { context, publish } = makeContext({
      allowNetwork: false,
      stored: { models: storedModels, checkedAt: 123 },
    });
    const result = await refreshOllamaCatalog(context);
    expect(result.map((m) => m.id)).toEqual(["stored-a", "stored-b"]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("returns the baseline immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const publish = vi.fn<Publish>().mockResolvedValue(true);
    const result = await refreshOllamaCatalog({
      allowNetwork: true,
      signal: controller.signal,
      publish,
    });
    expect(result).toEqual(GENERATED_MODELS);
    expect(publish).not.toHaveBeenCalled();
  });

  it("falls back to GENERATED_MODELS when the stored catalog is empty", async () => {
    const { context, publish } = makeContext({
      allowNetwork: false,
      stored: { models: [], checkedAt: Date.now() },
    });
    const result = await refreshOllamaCatalog(context);
    expect(result).toEqual(GENERATED_MODELS);
    expect(publish).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Network phase
// ============================================================================

describe("refreshOllamaCatalog network phase", () => {
  it("fetches the live catalog, persists it, and returns the assembled list", async () => {
    mockLiveApi();
    const { context, publish } = makeContext();
    const result = await refreshOllamaCatalog(context);

    expect(result.map((m) => m.id).sort()).toEqual(["plain-model", "thinking-model"]);
    expect(result.find((m) => m.id === "thinking-model")?.reasoning).toBe(true);
    expect(result.find((m) => m.id === "plain-model")?.reasoning).toBe(false);

    expect(publish).toHaveBeenCalledTimes(1);
    const persisted = publish.mock.calls[0][0].persist;
    expect(persisted).toBeDefined();
    if (persisted) {
      expect(persisted.models).toHaveLength(2);
      expect(persisted.models[0].provider).toBe("ollama-cloud");
      expect(persisted.checkedAt).toEqual(expect.any(Number));
    }
  });

  it("propagates a network failure without publishing", async () => {
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    const { context, publish } = makeContext();
    await expect(refreshOllamaCatalog(context)).rejects.toThrow("Failed to fetch model list");
    expect(publish).not.toHaveBeenCalled();
  });

  it("propagates when every /api/show request fails, without publishing", async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    };
    const { context, publish } = makeContext();
    await expect(refreshOllamaCatalog(context)).rejects.toThrow("Failed to fetch model details");
    expect(publish).not.toHaveBeenCalled();
  });

  it("surfaces a partial failure without persisting when there is no stored catalog", async () => {
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "ok-model" }, { id: "bad-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { model: string };
      if (body.model === "bad-model") {
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      return new Response(JSON.stringify({ capabilities: ["tools"], model_info: {} }), { status: 200 });
    };
    const { context, publish } = makeContext();
    await expect(refreshOllamaCatalog(context)).rejects.toThrow("catalog refresh incomplete");
    expect(publish).not.toHaveBeenCalled();
  });

  it("keeps the last-good catalog, advances checkedAt, and surfaces the error on a partial failure with a stored catalog", async () => {
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "ok-model" }, { id: "bad-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { model: string };
      if (body.model === "bad-model") {
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      return new Response(JSON.stringify({ capabilities: ["tools"], model_info: {} }), { status: 200 });
    };
    const storedModels = [makeStoredModel("stored-a")];
    const { context, publish } = makeContext({
      stored: { models: storedModels, checkedAt: Date.now() - 5 * 60 * 60 * 1000 },
    });
    await expect(refreshOllamaCatalog(context)).rejects.toThrow("catalog refresh incomplete");
    expect(publish).toHaveBeenCalledTimes(1);
    const persisted = publish.mock.calls[0][0].persist;
    expect(persisted?.models.map((m) => m.id)).toEqual(["stored-a"]);
    expect(persisted?.checkedAt).toEqual(expect.any(Number));
  });

  it("returns the fallback and does not persist when the live catalog has no tools-capable models", async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ capabilities: ["text"], model_info: {} }), { status: 200 });
    };
    const { context, publish } = makeContext();
    const result = await refreshOllamaCatalog(context);
    expect(result).toEqual(GENERATED_MODELS);
    expect(publish).not.toHaveBeenCalled();
  });

  it("returns models even when publishing fails (best-effort persistence)", async () => {
    mockLiveApi();
    const publish = vi.fn<Publish>().mockRejectedValue(new Error("store write failed"));
    const { context } = makeContext({ publish });
    const result = await refreshOllamaCatalog(context);
    expect(result.map((m) => m.id).sort()).toEqual(["plain-model", "thinking-model"]);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("returns the baseline without publishing when aborted mid-fetch", async () => {
    // A fetch that only settles when the signal aborts. Fails if the signal
    // isn't forwarded, so a regression that drops the signal is caught.
    globalThis.fetch = async (_url, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("fetch called without an abort signal");
      return new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    };
    const { context, publish, controller } = makeContext();
    const promise = refreshOllamaCatalog(context);
    controller.abort();
    const result = await promise;
    expect(result).toEqual(GENERATED_MODELS);
    expect(publish).not.toHaveBeenCalled();
  });

  it("returns the baseline without publishing when aborted during detail fetches", async () => {
    // Model list succeeds, but /api/show calls hang until the signal fires.
    // Verifies the abort check between refreshOllamaCloudModels and assembleModels.
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), { status: 200 });
      }
      // /api/show — hang until aborted.
      const signal = init?.signal;
      if (!signal) throw new Error("fetch called without an abort signal");
      return new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    };
    const { context, publish, controller } = makeContext();
    const promise = refreshOllamaCatalog(context);
    // Let the model list resolve, then abort during the detail phase.
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const result = await promise;
    expect(result).toEqual(GENERATED_MODELS);
    expect(publish).not.toHaveBeenCalled();
  });

  it("skips the network fetch within the cooldown window when not forced", async () => {
    const storedModels = [makeStoredModel("stored-a")];
    const { context, publish } = makeContext({
      stored: { models: storedModels, checkedAt: Date.now() },
    });
    globalThis.fetch = async () => {
      throw new Error("should not fetch within cooldown");
    };
    const result = await refreshOllamaCatalog(context);
    expect(result.map((m) => m.id)).toEqual(["stored-a"]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("fetches when forced even within the cooldown window", async () => {
    mockLiveApi();
    const { context, publish } = makeContext({
      stored: { models: [makeStoredModel("stored-a")], checkedAt: Date.now() },
      force: true,
    });
    const result = await refreshOllamaCatalog(context);
    expect(result.map((m) => m.id).sort()).toEqual(["plain-model", "thinking-model"]);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("fetches when the stored catalog is older than the cooldown window", async () => {
    mockLiveApi();
    const { context, publish } = makeContext({
      stored: { models: [makeStoredModel("stored-a")], checkedAt: Date.now() - 5 * 60 * 60 * 1000 },
    });
    const result = await refreshOllamaCatalog(context);
    expect(result.map((m) => m.id).sort()).toEqual(["plain-model", "thinking-model"]);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
