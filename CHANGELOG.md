# CHANGELOG

All notable changes to this project will be documented in this file.

## [Unreleased]

- Add `/ollama-cloud-usage` command to show Ollama Cloud session (5h) and weekly (7d) usage limits, per-model request counts, and the 4-week activity cost, fetched from the undocumented `/api/usage` endpoint with the already-resolved API key.
- Add a footer usage status bar (`5h ▕███░░░░░░░▏ 34% 7d ▕████░░░░░░▏ 45%`) while an `ollama-cloud` model is active, refreshing every 5 minutes and after each agent turn. Segments are colored by usage level (green <60%, yellow 60-79%, red 80%+). The quota-bar concept is inspired by `@entelligentsia/pi-ollama-cloud-usage-tracker`. Off by default; enable with `/ollama-usage-status on` or `"usageStatus": true` in `ollama-cloud.json`.
- Add `/ollama-usage-status [on|off|enable|disable]` to toggle the footer usage status bar at runtime (toggles without an argument).
- Document the exported usage API (`fetchUsage`, `formatUsageStatusColored`, `getCloudApiKey`, validators) so custom status bars can reuse it.

## [0.8.0] - 2026-08-09

- **Breaking:** Migrate model refresh to pi's native `refreshModels` mechanism. Remove the `/ollama-cloud-refresh` command and the manual `~/.pi/agent/cache/ollama-cloud-models.json` cache. The catalog now refreshes automatically on startup, on `/model` open, and via `pi update --models`, persisted through pi's own `FileModelsStore`. Users should delete the orphaned cache file after upgrade: `rm ~/.pi/agent/cache/ollama-cloud-models.json`.
- The shipped `GENERATED_MODELS` list is now a first-launch fallback; releases are no longer required for model freshness (only for deprecation or pricing changes).
- Refresh the generated catalog from the live API: add `deepseek-v4-flash:0731`, `deepseek-v4-flash:preview`, and `kimi-k3`; remove `kimi-k2.5` and `minimax-m2.5`, which are no longer listed. Refresh models.dev pricing, including the new models. Thanks @noruthedev (#43).
- Requires a pi version with the `stored`/`publish` `RefreshModelsContext` (pi 0.84.0+). Add `@earendil-works/pi-ai` as a peer dependency.
- Web tools now throw on errors instead of returning an `isError` result, aligning with pi 0.84.0's `AgentToolResult` contract.
- Fix `ollama_web_fetch` failing on pages where the API returns `links: null` (e.g. GitHub PR pages); the response is now accepted and rendered without a links list.
- Refresh robustness: add a 4-hour cooldown so repeated `/model` opens don't re-fetch the catalog; on a partial refresh failure, keep the last-good catalog and surface the error instead of silently returning an incomplete list.
- Add `tsgo --noEmit` type-checking to `npm run check` and CI.

## [0.7.0] - 2026-07-18

- Fix extension crash on pi 0.80.8+ where `AuthStorage` is no longer exported by `@earendil-works/pi-coding-agent`. Web tools now resolve the API key through the tool execution context's `modelRegistry.getApiKeyForProvider()`, preserving runtime/CLI overrides and the registered `apiKey: "$OLLAMA_API_KEY"` config. Thanks @badlogic for the cross-version analysis (#34, #35, #37).
- Restore the `OLLAMA_API_KEY` env-var fallback in `ollama_web_search` and `ollama_web_fetch`. Thanks @cawilliamson (#26).
- Add a 15s timeout to web search/fetch requests and preserve tool-cancellation by extending `fetchJsonWithTimeout` with an external `AbortSignal`.
- Always target `https://ollama.com` and warn when `OLLAMA_API_BASE` is set to a non-cloud host, instead of silently querying a local Ollama daemon. Thanks @valueforvalue (#32, #33).
- Add a `glm-5.2` thinking level map exposing `off`, `high`, and `xhigh` (`reasoning_effort: "none"`, `"high"`, `"max"`). Thanks @Thinkscape (#29).
- Add estimated per-token pricing for Ollama Cloud models so `/cost` shows comparable usage. Prices are generated from [models.dev](https://models.dev) (the same source pi uses) via `scripts/generate-pricing.ts` into `pricing.generated.ts`, not hand-typed, and regenerate with the catalog via `npm run generate-models`. Prices are pinned to the installed package version: `/ollama-cloud-refresh` updates the model list and metadata but does not re-fetch prices, so newly added models register with zero cost until the next release. Not actual subscription charges. Thanks @DxTa (#9).
- Refresh the generated model catalog from the live Ollama Cloud API. Adds `glm-5.2` (1M context, text-only) and `kimi-k2.7-code` (262K context, text + image). `deepseek-v4-pro` context window is now 524288 (was 1048576).
- Retire models deprecated per https://docs.ollama.com/cloud#deprecations: July 15, 2026 batch (`deepseek-v3.1:671b`, `deepseek-v3.2`, `devstral-2:123b`, `devstral-small-2:24b`, `ministral-3:14b`, `ministral-3:3b`, `ministral-3:8b`, `gemini-3-flash-preview`, `gemma3:12b`, `gemma3:27b`, `gemma3:4b`, `glm-4.7`, `glm-5`, `minimax-m2.1`, `qwen3-coder-next`, `qwen3-coder:480b`) and June 30 (`rnj-1:8b`). The shipped catalog goes from 30 to 18 models.
- Bump `@earendil-works/pi-coding-agent` runtime dependency to 0.80.10.

## [0.6.0] - 2026-06-05

- Fix `apiKey` registered as a literal string instead of an environment variable reference. Changed `apiKey: "OLLAMA_API_KEY"` to `apiKey: "$OLLAMA_API_KEY"` in `registerProvider`, resolving the deprecation warning emitted by pi v0.77.0+ and making the `OLLAMA_API_KEY` env var work alongside `auth.json` (env var takes priority, falls back to `auth.json`). Thanks @mandusm (#21).
- Make `scripts/generate-models.ts` produce a stable output: sort models by `id` and each object's keys alphabetically (with `id` and `name` first), so regenerating the catalog produces minimal diffs. Thanks @shyim for the idea (#22).
- Exclude models announced for retirement (effective 2026-06-16) from the generated `GENERATED_MODELS` list: `kimi-k2-thinking`, `kimi-k2:1t`, `minimax-m2`, `glm-4.6`, `qwen3-next:80b`, `qwen3-vl:235b`, `qwen3-vl:235b-instruct`, `cogito-2.1:671b`. See https://docs.ollama.com/cloud#deprecations. `/ollama-cloud-refresh` will still register them from the live API until Ollama removes them.

## [0.5.0] - 2026-05-22

- Update `peerDependencies` and imports to the new `@earendil-works/*` packages.
- Add build script (`scripts/generate-models.ts`) to generate `models.generated.ts` with Ollama Cloud tool-capable models from live API data. The script requires no API key.
- Drop `FALLBACK_MODELS` in favor of `GENERATED_MODELS` which ships with the package.
- Remove `apiKey` requirement from `fetchModelIds` and `fetchModelDetails`. Ollama Cloud's public `/v1/models` and `/api/show` endpoints do not require authentication for model metadata. (#15)
- Remove `getOllamaCloudApiKey`, `refreshModelsFromAuth`, and the "No API key found" notification path from `fetchModels`. Users can now browse model metadata without configuring a key.
- Remove `401`/`403` error handling from the model metadata fetch functions.
- Add configuration system (`config.ts`) with JSON config files (global + project-local) and `/ollama-webtools` command for runtime web tools toggling.
- Add test infrastructure (`vitest`) and model validation tests (`test/models.test.ts`).
- Add HTTP status-aware error handling in web tools (`401`/`403` → auth error, `429` → rate limit).
- Add explicit `buildCompat()` with all 17 `OpenAICompletionsCompat` flags set explicitly, verified against Ollama API docs.
- Set the provider display name to `Ollama Cloud` so it reads cleanly in `/login`, `/model`, and the model selector.
- Document `/login` as the recommended way to configure the API key.
- Update README to clarify baked-in model list and refresh behavior.
- Document web-tools.ts module boundaries in file header comment.

## [0.4.1] - 2026-05-07

- Add `renderCall` to `ollama_web_search` and `ollama_web_fetch` tools so the TUI displays the query/URL in the tool call header instead of just the bare tool name. (#12)

## [0.4.0] - 2026-05-06

- Fix `/api/chat` requests not disabling thinking when Pi's thinking level is set to `off`. Maps Pi `off` to `reasoning_effort: "none"` on models where the API respects it, hides the `off` level on models where it doesn't (gpt-oss, kimi-k2-thinking, minimax, qwen3-vl). (#6)
- Add `thinking-levels.ts` with curated per-model thinking level maps (DEFAULT, GPT_OSS, QWEN3, NO_OFF), validated against all 24 thinking-capable models via automated experiment (see docs/think-experiment.md).
- Fix system prompt (AGENTS.md content) not being read by GLM models by setting `supportsDeveloperRole: false` on all registered models.
- Rename smoke test to test, add lint step.
- Treat stale local model caches as usable for immediate startup while triggering the same visible refresh flow as `/ollama-cloud-refresh` on `session_start`; use fallback models only when the cache is missing or invalid.
- Add a single-line `/ollama-cloud-refresh` progress widget showing the current stage, count, percentage, failures, and progress bar.
- Add thinking on/off assertions to the CI test workflow.

## [0.3.1] - 2026-05-05

- Fix `OLLAMA_API_KEY` env var not being respected by `fetchModels` and web tools. pi-ai does not know about the `ollama-cloud` provider ID, so `AuthStorage.getApiKey()` alone misses the env var. Added explicit `process.env.OLLAMA_API_KEY` fallback.
- Switch web tools to `AuthStorage.create()` for API key lookup, matching the `models.ts` auth pattern from v0.2.1.
- Add null-safe access to `data.details?.family` in `resolveThinkingLevelMap`.
- Change `OLLAMA_BASE` from `export let` to `export const` to prevent accidental mutation.
- Fix fallback model IDs to use real Ollama Cloud identifiers (`glm-5.1`, `gemma4:31b`) instead of synthetic `:cloud` suffixes.
- Add smoke test workflow for CI.

## [0.3.0] - 2026-05-04

- Derive `thinkingLevelMap` from pi's built-in model definitions instead of hardcoding model-family mappings. The extension now picks up thinking level metadata automatically when pi-mono adds or updates it for any model.
- Add family-based fallback matching: when an Ollama Cloud model ID doesn't match a pi model ID exactly, the extension now tries matching by model family (via Ollama's `details.family` field). For example, `gemma4:31b` correctly picks up Gemma 4's thinking level map from pi.

## [0.2.1] - 2026-04-29

- Fix API key retrieval by using `AuthStorage` instead of `ctx.modelRegistry.getApiKeyForProvider`. The provider-level API key lookup was failing, causing auth to only work when an environment variable was set. Now reads from `auth.json` directly via the pi `AuthStorage` class.

## [0.2.0] - 2026-04-28

- Add `PI_OLLAMA_WEB_TOOLS` environment variable to optionally disable `ollama_web_search` and `ollama_web_fetch` tool registrations. Set to `0`, `false`, `no`, `off`, or an empty string to opt-out. The model provider and `/ollama-cloud-refresh` command remain active regardless.

