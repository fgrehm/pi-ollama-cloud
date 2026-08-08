# pi-ollama-cloud — review guidance

<!--
Reviewer-facing subset for Copilot code review on github.com, which reads only
.github/copilot-instructions.md and *.instructions.md (not AGENTS.md). The full
implementer rules live in ../AGENTS.md; this file is a deliberate slim subset
scoped to what a reviewer should flag, not a mirror.
-->

This is a Pi extension: TypeScript (strict, ESM), Biome for lint/format, Vitest for tests. The published npm package ships `.ts` sources as-is. `models.generated.ts` is a first-launch fallback only (the live catalog refreshes at runtime via pi's native `refreshModels`); `pricing.generated.ts` is generated from [models.dev](https://models.dev). Review changes against the patterns below.

## Verification

A change is not CI-validated unless `npm run check` (lint + format) and `npm run test` pass, and any new `npm run` script is wired into `.github/workflows/test.yml`.

## Things to Flag

- A new `fetch` call that does not use `fetchJsonWithTimeout` from `utils.ts` (loses the timeout, abort signal, and `{ ok, status, data, error }` shape).
- Auth headers that can emit `Authorization: Bearer undefined`. The header must be set only when an API key is present, to preserve anonymous access to `ollama.com` endpoints (`/v1/models`, `/api/show`).
- 401/403 vs 429 collapsed into one generic message. Auth errors should mention the API key env var and `auth.json`; rate-limit errors should say "try again shortly".
- A new `Promise.allSettled` / `Promise.all` / `concurrentMap` site that swallows rejections without counting and surfacing them.
- A `try` block around `setTimeout` / `AbortController` / file I/O that lacks a paired `finally` for cleanup.
- `JSON.parse` results used without guarding against `null`, arrays, and primitives when an object is expected (see `config.ts`).
- A schema parameter using `Type.String` / `Type.Number` where `Type.Integer` with `minimum`/`maximum`, or `format: "uri"`, would enforce the constraint at the boundary.
- A new slash command that does not validate its argument and notify on unknown values.
- Provider registration that bypasses `assembleModels()` (see Canonical pattern below).
- Missing file in `package.json` `files` after a new runtime module is added (CI does not catch this; npm ships a broken package).
- Workflow permission changes that drop `contents: read` or `id-token: write` (breaks OIDC trusted publishing).
- Hand-edits to `pricing.generated.ts`, or large `models.generated.ts` regen diffs that are not pure additions and not documented retirements (likely a sort-order regression in `scripts/generate-models.ts`).
- README or inline comments left stale when observable behavior changes.

## Canonical pattern: go through `assembleModels()`

```typescript
// Avoid: hand-rolled ProviderModelConfig in a code path
pi.registerProvider("ollama-cloud", {
  name: "Ollama Cloud",
  baseUrl: `${OLLAMA_BASE}/v1`,
  apiKey: "$OLLAMA_API_KEY",
  api: "openai-completions",
  models: someHandRolledArray,
});

// Prefer: always go through assembleModels()
const models = assembleModels(rawApiData);
pi.registerProvider("ollama-cloud", { /* ... */, models });
```

## Prefer / Avoid

- Prefer conditional `Authorization` headers over an always-set one. Set `Authorization: Bearer ${apiKey}` only when the key is non-empty; `Bearer undefined` breaks anonymous access to `/v1/models` and `/api/show`.
- Prefer `Type.Integer` with `minimum`/`maximum` over `Type.Number` for tool params. The runtime rejects out-of-range integers at the boundary; `Type.Number` lets `2.5` through.
- Prefer `fetchJsonWithTimeout` over raw `fetch`.

## What Not To Comment On

Per [Copilot's documented limits](https://docs.github.com/en/copilot/tutorials/customize-code-review), do not request:

- Changes to PR overview formatting, or bold/emoji/color in review comments.
- Following external standards or links by URL (inline the relevant rules instead).
- Vague quality improvements ("be more thorough", "don't miss issues").
- Blocking the PR or generating changelog entries automatically.
- Style and formatting (indent, line width, import order, quote style, trailing commas) — that is Biome's job. Do not duplicate it.
