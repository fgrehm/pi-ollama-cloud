import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { MODEL_MAX_OUTPUT_TOKENS } from "../limits.generated.ts";
import { GENERATED_MODELS } from "../models.generated.ts";
import { assembleModels, fetchModelDetails, fetchModelIds } from "../models.ts";
import { MODEL_PRICING } from "../pricing.generated.ts";
import { resolve } from "../thinking-levels.ts";
import { getContextLength } from "../utils.ts";

// --- Helpers ---

/** Minimal valid /api/show response matching the real Ollama Cloud API shape. */
function rawModel(
  overrides: {
    capabilities?: string[];
    modelInfo?: Record<string, unknown>;
    details?: Partial<{
      parent_model: string;
      format: string;
      family: string;
      families: string[] | null;
      parameter_size: string;
      quantization_level: string;
    }>;
  } = {},
) {
  return {
    details: {
      parent_model: "",
      format: "",
      family: "test",
      families: null,
      parameter_size: "7000000000",
      quantization_level: "Q4_K_M",
      ...overrides.details,
    },
    model_info: overrides.modelInfo ?? {},
    // Real API always includes "completion"; we omit it since
    // assembleModels only checks for "tools", "thinking", and "vision".
    capabilities: overrides.capabilities ?? ["tools"],
    modified_at: new Date().toISOString(),
  };
}

// ============================================================================
// assembleModels
// ============================================================================

describe("assembleModels", () => {
  it("rejects malformed capabilities and model_info at assembly", () => {
    expect(() => assembleModels({ malformed: { capabilities: "tools", model_info: {} } })).toThrow(
      "Invalid /api/show response for malformed",
    );
    expect(() => assembleModels({ malformed: { capabilities: [null], model_info: {} } })).toThrow(
      "Invalid /api/show response for malformed",
    );
    expect(() => assembleModels({ malformed: { capabilities: ["tools"], model_info: [] } })).toThrow(
      "Invalid /api/show response for malformed",
    );
  });

  it("filters out models without tools capability", () => {
    const raw = {
      "no-tools": rawModel({ capabilities: ["thinking"] }),
      "has-tools": rawModel(),
    };
    const models = assembleModels(raw);
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("has-tools");
  });

  it("sets id and name from the model key", () => {
    const raw = { "glm-5.1": rawModel() };
    const models = assembleModels(raw);
    expect(models[0].id).toBe("glm-5.1");
    expect(models[0].name).toBe("glm-5.1");
  });

  it("defaults reasoning to false when thinking capability is absent", () => {
    const models = assembleModels({ m: rawModel() });
    expect(models[0].reasoning).toBe(false);
    expect(models[0].thinkingLevelMap).toBeUndefined();
  });

  it("sets reasoning to true and assigns DEFAULT map when thinking is present", () => {
    const models = assembleModels({ m: rawModel({ capabilities: ["tools", "thinking"] }) });
    expect(models[0].reasoning).toBe(true);
    expect(models[0].thinkingLevelMap).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });
  });

  it("defaults input to text-only", () => {
    const models = assembleModels({ m: rawModel() });
    expect(models[0].input).toEqual(["text"]);
  });

  it("adds image to input when vision capability is present", () => {
    const models = assembleModels({ m: rawModel({ capabilities: ["tools", "vision"] }) });
    expect(models[0].input).toEqual(["text", "image"]);
  });

  it("sets all compat flags explicitly on every model", () => {
    const models = assembleModels({ m: rawModel() });
    // assembleModels always emits an OpenAICompletionsCompat (see buildCompat);
    // the static type is a union over all APIs, so narrow it for the assertions.
    const compat = models[0].compat as OpenAICompletionsCompat | undefined;

    // Tested against the live API (docs/openai.md):
    expect(compat?.supportsDeveloperRole).toBe(false);
    expect(compat?.supportsReasoningEffort).toBe(true);
    expect(compat?.thinkingFormat).toBe("openai");

    // Verified against docs/openai.md:
    // "store" is not listed, Ollama lists "max_tokens" not "max_completion_tokens",
    // stream_options.include_usage is supported, tool_choice is not supported.
    expect(compat?.supportsStore).toBe(false);
    expect(compat?.maxTokensField).toBe("max_tokens");
    expect(compat?.supportsUsageInStreaming).toBe(true);
    expect(compat?.supportsStrictMode).toBe(false);

    // Verified against docs/anthropic.md: prompt caching is "Not supported".
    expect(compat?.cacheControlFormat).toBeUndefined();

    // Standard OpenAI-compatible defaults:
    expect(compat?.requiresToolResultName).toBe(false);
    expect(compat?.requiresAssistantAfterToolResult).toBe(false);
    expect(compat?.requiresThinkingAsText).toBe(false);
    expect(compat?.requiresReasoningContentOnAssistantMessages).toBe(false);
    expect(compat?.sendSessionAffinityHeaders).toBe(false);
    expect(compat?.supportsLongCacheRetention).toBe(false);
    expect(compat?.zaiToolStream).toBe(false);
    // Omitted on purpose: empty objects are truthy in pi-ai and would send provider: {}.
    expect(compat?.openRouterRouting).toBeUndefined();
    expect(compat?.vercelGatewayRouting).toBeUndefined();
  });

  it("zeros cost for models with no models.dev pricing mapping", () => {
    const models = assembleModels({ m: rawModel() });
    expect(models[0].cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("prices mapped models from the generated models.dev table", () => {
    const models = assembleModels({ "glm-5.2": rawModel({ capabilities: ["tools", "thinking"] }) });
    expect(models[0].cost).toEqual(MODEL_PRICING["glm-5.2"]);
    expect(models[0].cost.input).toBeGreaterThan(0);
  });

  it("extracts contextWindow from model_info using .context_length suffix", () => {
    const models = assembleModels({
      m: rawModel({ modelInfo: { "test.context_length": 262144 } }),
    });
    expect(models[0].contextWindow).toBe(262144);
  });

  it("falls back to 128000 when context_length is missing from model_info", () => {
    // Default from getContextLength(), documented in README table.
    const models = assembleModels({ m: rawModel() });
    expect(models[0].contextWindow).toBe(128000);
  });

  it("resolves maxTokens from the probed limits table", () => {
    const models = assembleModels({ "glm-5.2": rawModel() });
    expect(models[0].maxTokens).toBe(MODEL_MAX_OUTPUT_TOKENS["glm-5.2"]);
  });

  it("falls back to 32768 when a model has no probed limit", () => {
    const models = assembleModels({ m: rawModel() });
    expect(models[0].maxTokens).toBe(32768);
  });

  describe("thinking level maps", () => {
    it("maps gpt-oss models from models.dev (effort low/medium/high, off hidden)", () => {
      const models = assembleModels({
        "gpt-oss:20b": rawModel({ capabilities: ["tools", "thinking"] }),
        "gpt-oss:120b": rawModel({ capabilities: ["tools", "thinking"] }),
      });
      for (const m of models) {
        expect(m.thinkingLevelMap).toEqual({
          off: null,
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: null,
        });
      }
    });

    it("maps toggle-only models (gemma4) to a binary on/off map", () => {
      const models = assembleModels({ "gemma4:31b": rawModel({ capabilities: ["tools", "thinking"] }) });
      expect(models[0].thinkingLevelMap).toEqual({
        off: "none",
        minimal: null,
        low: null,
        medium: "medium",
        high: null,
        xhigh: null,
      });
    });

    it("assigns DEFAULT to models with no models.dev reasoning entry", () => {
      const models = assembleModels({ "mistral-large-3:675b": rawModel({ capabilities: ["tools", "thinking"] }) });
      expect(models[0].thinkingLevelMap).toEqual({
        off: "none",
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "max",
      });
    });

    it("maps deepseek-v4.1-flash effort (low/high/max, no medium)", () => {
      // models.dev lists efforts [low, high, max] for this model; medium is
      // unsupported, so it maps to null instead of the DEFAULT passthrough.
      const models = assembleModels({ "deepseek-v4.1-flash": rawModel({ capabilities: ["tools", "thinking"] }) });
      expect(models[0].thinkingLevelMap).toEqual({
        off: "none",
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        xhigh: "max",
      });
    });

    it("maps glm-5.2 effort (high/xhigh only)", () => {
      const models = assembleModels({ "glm-5.2": rawModel({ capabilities: ["tools", "thinking"] }) });
      expect(models[0].thinkingLevelMap).toEqual({
        off: "none",
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: "max",
      });
    });

    it("hides off for minimax-m2.7 (none does not disable thinking)", () => {
      const models = assembleModels({ "minimax-m2.7": rawModel({ capabilities: ["tools", "thinking"] }) });
      expect(models[0].thinkingLevelMap).toEqual({
        off: null,
        minimal: null,
        low: null,
        medium: "medium",
        high: null,
        xhigh: null,
      });
    });
  });
});

// ============================================================================
// GENERATED_MODELS (baked-in cold-start list)
// ============================================================================

describe("GENERATED_MODELS", () => {
  it("ships at least one model", () => {
    expect(GENERATED_MODELS.length).toBeGreaterThan(0);
  });

  it("ships the full explicit compat shape from buildCompat", () => {
    // The baked-in list must match assembleModels output so cold-start
    // users get the same compat contract as native refreshModels users.
    for (const m of GENERATED_MODELS) {
      expect(m.compat).toMatchObject({
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        supportsStore: false,
        maxTokensField: "max_tokens",
        supportsUsageInStreaming: true,
        requiresToolResultName: false,
        requiresAssistantAfterToolResult: false,
        requiresThinkingAsText: false,
        requiresReasoningContentOnAssistantMessages: false,
        thinkingFormat: "openai",
        supportsStrictMode: false,
        sendSessionAffinityHeaders: false,
        supportsLongCacheRetention: false,
        zaiToolStream: false,
      });
    }
  });
});

// ============================================================================
// resolve (thinking level maps)
// ============================================================================

describe("resolve", () => {
  it("returns undefined for models without thinking capability", () => {
    expect(resolve("any-model", [])).toBeUndefined();
    expect(resolve("any-model", ["tools"])).toBeUndefined();
    expect(resolve("any-model", ["tools", "vision"])).toBeUndefined();
  });

  it("returns DEFAULT for models with no models.dev reasoning entry", () => {
    // mistral-large-3:675b has no models.dev ollama-cloud entry (and no
    // family entry either), so resolve() cannot even match its tagged id.
    expect(resolve("mistral-large-3:675b", ["tools", "thinking"])).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });
    expect(resolve("unknown-model", ["tools", "thinking"])).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });
  });

  it("applies the gpt-oss off restriction to fallback maps for new family variants", () => {
    expect(resolve("gpt-oss:future-tag", ["tools", "thinking"])).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });
  });

  it("maps gpt-oss effort levels and hides off (none does not disable thinking)", () => {
    // gpt-oss:20b / gpt-oss:120b: models.dev effort = [low, medium, high];
    // OFF_NULL hides off because live probing shows "none" still reasons.
    expect(resolve("gpt-oss:20b", ["tools", "thinking"])).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
    });
    expect(resolve("gpt-oss:120b", ["tools", "thinking"])).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
    });
  });

  it("maps toggle-only models to a binary on/off map", () => {
    // gemma4:31b and qwen3.5:397b: models.dev reasoning_options = [toggle] only.
    expect(resolve("gemma4:31b", ["tools", "thinking"])).toEqual({
      off: "none",
      minimal: null,
      low: null,
      medium: "medium",
      high: null,
      xhigh: null,
    });
    expect(resolve("qwen3.5:397b", ["tools", "thinking"])).toEqual({
      off: "none",
      minimal: null,
      low: null,
      medium: "medium",
      high: null,
      xhigh: null,
    });
  });

  it("hides off for minimax-m2.7 (none does not disable thinking), binary map otherwise", () => {
    // minimax-m2.7: models.dev = [toggle]; OFF_NULL hides off (live probe leaks).
    expect(resolve("minimax-m2.7", ["tools", "thinking"])).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: "medium",
      high: null,
      xhigh: null,
    });
  });

  it("applies OFF_NULL to a tagged id that resolves to its family", () => {
    // minimax-m2.7:latest has no models.dev entry; it matches the family
    // minimax-m2.7, so OFF_NULL must still hide the off toggle.
    expect(resolve("minimax-m2.7:latest", ["tools", "thinking"])).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: "medium",
      high: null,
      xhigh: null,
    });
  });

  it("falls back to DEFAULT for an empty reasoning_options list", () => {
    // minimax-m2.5 ships [] in models.dev — no verified options, so DEFAULT is
    // safer than a degenerate map whose only selectable level can be a
    // leaking off toggle.
    expect(resolve("minimax-m2.5", ["tools", "thinking"])).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });
  });

  it("ignores inherited Object keys when looking up reasoning options", () => {
    // A model id like "constructor" must not resolve to the inherited
    // constructor function reached via plain-object property access.
    expect(resolve("constructor", ["tools", "thinking"])).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });
    // ... including the family path ("constructor:latest" -> "constructor").
    expect(resolve("constructor:latest", ["tools", "thinking"])).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });
  });

  it("maps effort values onto the matching levels", () => {
    // glm-5.2: effort = [high, max] -> high + extra-high only.
    expect(resolve("glm-5.2", ["tools", "thinking"])).toEqual({
      off: "none",
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: "max",
    });
    // glm-5.3 / glm-5.3-flash: effort = [low, high, max] -> low, high, extra-high.
    expect(resolve("glm-5.3", ["tools", "thinking"])).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: "max",
    });
    // minimax-m3: toggle + effort = [low, medium, high, max] -> all but minimal.
    expect(resolve("minimax-m3", ["tools", "thinking"])).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });
  });

  it("resolves a :tag family to the family's reasoning options", () => {
    // deepseek-v4-pro:0813 -> models.dev family "deepseek-v4-pro" (effort [high, max]).
    expect(resolve("deepseek-v4-pro:0813", ["tools", "thinking"])).toEqual({
      off: "none",
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: "max",
    });
  });

  it("returns undefined when thinking is absent regardless of prefix", () => {
    expect(resolve("gpt-oss:20b", ["tools"])).toBeUndefined();
    expect(resolve("qwen3:397b", ["tools"])).toBeUndefined();
    expect(resolve("minimax-m2.7", ["tools"])).toBeUndefined();
  });
});

// ============================================================================
// getContextLength
// ============================================================================

describe("getContextLength", () => {
  it("extracts context length from any key ending in .context_length", () => {
    expect(getContextLength({ "test.context_length": 262144 })).toBe(262144);
    expect(getContextLength({ "some-prefix.context_length": 128000 })).toBe(128000);
  });

  it("returns first match when multiple context_length keys exist", () => {
    expect(
      getContextLength({
        "a.context_length": 100000,
        "b.context_length": 200000,
      }),
    ).toBe(100000);
  });

  it("falls back to 128000 when no valid context_length exists", () => {
    expect(getContextLength({})).toBe(128000);
    expect(getContextLength({ some_other_key: 42 })).toBe(128000);
    expect(getContextLength({ "test.context_length": 0 })).toBe(128000);
    expect(getContextLength({ "test.context_length": -1 })).toBe(128000);
    expect(getContextLength({ "test.context_length": 1.5 })).toBe(128000);
    expect(getContextLength({ "test.context_length": Number.POSITIVE_INFINITY })).toBe(128000);
  });

  it("ignores context_length values that are not numbers", () => {
    expect(getContextLength({ "test.context_length": "not-a-number" })).toBe(128000);
  });
});

// fetchModelIds error handling
// ============================================================================

describe("fetchModelIds", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws rate limit error on 429", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "too many requests" }), { status: 429 });
    await expect(fetchModelIds()).rejects.toThrow("Ollama Cloud model list fetch rate limited");
  });

  it("throws generic error on other failures", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "server error" }), { status: 500 });
    await expect(fetchModelIds()).rejects.toThrow("Failed to fetch model list");
  });

  it("rejects malformed successful responses and IDs", async () => {
    for (const body of [null, [], {}, { data: [null] }, { data: [{}] }, { data: [{ id: "  " }] }]) {
      globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
      await expect(fetchModelIds()).rejects.toThrow(/unexpected response shape|invalid model ID/);
    }
  });

  it("returns model IDs on success", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [{ id: "qwen3" }, { id: "gemma3" }] }), {
        status: 200,
      });
    const ids = await fetchModelIds();
    expect(ids).toEqual(["qwen3", "gemma3"]);
  });
});

describe("fetchModelDetails", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws rate limit error on 429", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "too many requests" }), { status: 429 });
    await expect(fetchModelDetails("qwen3")).rejects.toThrow("Ollama Cloud /api/show rate limited");
  });

  it("throws generic error on other failures", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    await expect(fetchModelDetails("unknown")).rejects.toThrow("Failed to fetch /api/show");
  });

  it("accepts missing/null model_info but rejects present malformed metadata", async () => {
    for (const body of [{ capabilities: ["tools"] }, { capabilities: ["tools"], model_info: null }]) {
      globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
      const details = await fetchModelDetails("qwen3");
      expect(assembleModels({ qwen3: details })[0].contextWindow).toBe(128000);
    }

    for (const body of [
      { capabilities: "tools", model_info: {} },
      { capabilities: [null], model_info: {} },
      { capabilities: ["tools"], model_info: [] },
      { capabilities: ["tools"], model_info: "invalid" },
    ]) {
      globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
      await expect(fetchModelDetails("qwen3")).rejects.toThrow("unexpected response shape");
    }
  });

  it("returns model details on success", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          capabilities: ["tools"],
          model_info: { "test.context_length": 131072 },
        }),
        { status: 200 },
      );
    const details = await fetchModelDetails("qwen3");
    expect(details.capabilities).toContain("tools");
    expect(details.model_info).toBeDefined();
  });
});
