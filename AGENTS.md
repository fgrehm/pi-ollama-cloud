# Development Rules

Canonical instructions for local coding agents (Pi, Copilot coding agent). Claude Code does not read this file directly; add a `CLAUDE.md` importing `@AGENTS.md` if you want it to. The reviewer-facing subset for Copilot code review on github.com lives in [`.github/copilot-instructions.md`](.github/copilot-instructions.md); that file is intentionally a slim subset, not a mirror.

## Conversational Style

- Keep answers short and concise.
- No emojis in commits, issues, PR comments, or code.
- No fluff or cheerful filler text.
- Technical prose only, be direct.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check `node_modules` for external API types; do not guess.
- No inline imports (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Strict TypeScript: no `enum`, no `namespace`/`module`, no `import =`, no `export =`, no parameter properties. Use explicit fields with constructor assignments if needed.

## Module Boundaries

This is a Pi extension. The split is intentional, do not collapse it:

- `index.ts` — Extension entry point. Provider registration, command registration, session lifecycle hooks. Should not call the network directly; delegate to `models.ts` and `web-tools.ts`.
- `models.ts` — Provider data plane: API constants, model assembly, fetch helpers, and the `refreshOllamaCatalog` callback wired as `refreshModels` in `index.ts`. Owns `OLLAMA_BASE`.
- `web-tools.ts` — `ollama_web_search` and `ollama_web_fetch` tool registrations. Self-contained; depends on `models.ts` for `OLLAMA_BASE` and `utils.ts` for `fetchJsonWithTimeout`.
- `config.ts` — JSON config file loader, env-var resolution, and schema validation (`CONFIG_SCHEMA` / `sanitizeConfig`).
- `thinking-levels.ts` — Per-model reasoning-effort maps. Pure data + a single resolve function.
- `utils.ts` — Cross-cutting helpers (`fetchJsonWithTimeout`, `concurrentMap`, `getContextLength`). Keep small.
- `scripts/generate-models.ts` — Generator script. Runs against the live API to refresh `models.generated.ts`. Not shipped at runtime.
- `scripts/generate-pricing.ts` — Generator script. Fetches `https://models.dev/api.json` plus the Ollama model list and writes `pricing.generated.ts` via a curated `OLLAMA_TO_MODELSDEV` mapping. Not shipped at runtime.
- `models.generated.ts` — Generated output of `scripts/generate-models.ts`. **Do not edit by hand.** Regenerate via `npm run generate-models` and commit the result.
- `pricing.generated.ts` — Generated output of `scripts/generate-pricing.ts`. Shipped at runtime (in `package.json` `files`). **Do not edit by hand.**

When adding a new **runtime** module (a `.ts` file that ships):

- Add it to `package.json` `files` in the same PR. CI does not catch missing entries; npm will silently ship a broken package. Test files and `scripts/` are not shipped and must not be added.

## Error Handling

- Never silently swallow rejections from `Promise.allSettled`, `Promise.all`, or `concurrentMap`. Count failures, surface them in the final notification, and let the caller decide.
- `try/finally` is mandatory for every `setTimeout` and `AbortController`. Cleanup must run on the error path, not only the happy path.
- Validate `JSON.parse` results before use. When the consumer expects an object, guard against `null`, arrays, and primitives. See `config.ts` for the pattern.
- User-facing error messages should name the operation, the failure mode, and the next step. Do not collapse distinct conditions (auth vs. rate limit vs. server error) into a single generic message.

## HTTP and Auth

- Prefer `fetchJsonWithTimeout` from `utils.ts` over raw `fetch` in `models.ts` and `web-tools.ts`. It centralizes the timeout, the abort signal, and the error-shape response (`{ ok, status, data, error }`). A bare `fetch` skips all three.
- Never send `Authorization: Bearer undefined`. Build the headers object first, then set `Authorization: Bearer ${apiKey}` only when an API key is present. Sending `Bearer undefined` to `ollama.com` breaks the anonymous-access endpoints (`/v1/models`, `/api/show`).
- Normalize user-provided base URLs by stripping trailing slashes before composing paths. `OLLAMA_BASE` does this; replicate the pattern anywhere a base URL is composed.
- Treat 401/403 and 429 distinctly in user-facing output. Auth errors should mention the API key env var and `auth.json`; rate-limit errors should say "try again shortly".
- Web tools resolve the API key via `ctx.modelRegistry.getApiKeyForProvider("ollama-cloud")` (with `?? process.env.OLLAMA_API_KEY` as a fallback). Do not import `AuthStorage` — it was removed from `@earendil-works/pi-coding-agent`'s public exports in 0.80.8+; importing it crashes the extension at load.
- Constrain tool parameters with `@sinclair/typebox` at the boundary: `Type.Integer` with `minimum`/`maximum`, `format: "uri"`, etc. Pi's runtime rejects out-of-range integers; a `Type.Number` lets `2.5` through. Do not push into `execute` what the schema can enforce.

## Command Input Validation

Slash commands with arguments must validate the argument and notify the user on unknown values. Do not silently fall through to a default state. `/ollama-webtools` does this; follow the same pattern.

## File-Specific Patterns

- `assembleModels()` in `models.ts` is the single source of truth for converting raw `/api/show` responses into `ProviderModelConfig[]`. `refreshOllamaCatalog` assembles the live catalog through it; do not hand-roll configs that diverge from its output.
- `buildCompat()` in `models.ts` sets every `OpenAICompletionsCompat` flag explicitly. If a new flag is added upstream, the function must set it (or explicitly `undefined`) for structural consistency with `assembleModels()` runtime output.
- `concurrentMap` in `utils.ts` is the preferred parallel-fetch helper. Reasonable worker default is 8; very high values risk rate limits.
- `getContextLength` falls back to 128000 when the API does not report one. The fallback is intentional, not a TODO.

## Generated Files

- `models.generated.ts` is regenerated by `scripts/generate-models.ts`. The script sorts models by id and object keys alphabetically (with `id`/`name` first) for minimal diffs. If your regen produces large diffs, the script is probably broken; do not hand-edit the file into shape.
- `pricing.generated.ts` is regenerated by `scripts/generate-pricing.ts` from `https://models.dev/api.json` (the same source pi uses), keyed by the curated `OLLAMA_TO_MODELSDEV` mapping (one line per Ollama model). Values are per-1M-token estimates written verbatim (no rounding). Do not hand-edit; regenerate via `npm run generate-models`, which runs `generate-pricing` first. Unmapped models get zero cost and a build-time warning — add a mapping line for new models.
- Models announced for retirement are excluded from `GENERATED_MODELS` (see `RETIRED_MODEL_IDS` in the script). The list is hardcoded — update it when Ollama announces new deprecations, with a CHANGELOG entry.
- `GENERATED_MODELS` is a first-launch fallback only; pi refreshes the live catalog at runtime via `refreshModels`, so regenerating the catalog is not needed for model freshness (see Releasing).

## Documentation Accuracy

The README and inline comments describe observable behavior. When the behavior changes, update both in the same change. Past drift caught in review: "background refresh" wording when the refresh is visible, "no API key required" for endpoints that do require one.

## Verification Commands

- After code changes (not docs): `npm run check`. Fix all errors, warnings, and infos before committing. `check` runs Biome (lint + format) and `tsgo --noEmit` (type-check).
- Run `npm run test` before pushing. CI runs lint, typecheck, and test; PRs that skip any will be rejected by the workflow.
- Never run `npm run build`. There is no compile or bundle step; the package ships TypeScript sources as-is. The only generation step is `npm run generate-models`, which runs `generate-pricing` then `generate-models` to refresh both `models.generated.ts` and `pricing.generated.ts` from the live API and models.dev.
- `npm run smoke:web-tools` runs a live smoke of `ollama_web_search`/`ollama_web_fetch` (needs `OLLAMA_API_KEY` or an `ollama-cloud` entry in `auth.json`). It runs in CI gated on `secrets.OLLAMA_CLOUD_API_KEY`.
- When adding a new `npm run` script, add a corresponding step in `.github/workflows/test.yml` if it should run in CI.
- When changing a workflow file, verify the `permissions:` block is still correct. `publish.yml` requires both `contents: read` and `id-token: write`; trimming either breaks OIDC trusted publishing.

## Changelog

Location: `CHANGELOG.md` at the repo root. All entries go under `## [Unreleased]` until a release cuts them into a dated version section.

- Released and unreleased versions are both flat bullet lists, no subsections. Match the style of the existing entries.
- Attribution for external contributions: append `Thanks @username (#N).` to the bullet, with the PR or issue number. Internal contributions are not attributed.
- Released version sections (e.g. `## [0.5.0]`) are immutable; never modify them.

## Commit Format

Conventional commits, present tense, under 72 characters.

```
feat: add /ollama-webtools on|off subcommand
feat(models): add refreshOllamaCatalog callback
docs: note catalog refresh is automatic via native refreshModels
```

Use scopes when they clarify the component: `models`, `web-tools`, `config`, `ci`, `docs`, `release`. Skip them for broad changes. `chore:` for non-functional changes (deps, regen output).

## Git

- Only commit files you changed in this session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` or `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `models.generated.ts` may be staged alongside your files when regenerating the catalog.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `git commit --no-verify`.

## Releasing

Lockstep versioning, single `package.json`. Full walkthrough in the README; the checklist:

1. Move `## [Unreleased]` entries to a new dated version section in `CHANGELOG.md`.
2. `npm version patch` (or `minor` / `major`). Tag and push in one step: `git push --tags`.
3. The push triggers `.github/workflows/publish.yml`, which smoke-tests against the live API, verifies tag/version match, and publishes via npm OIDC trusted publishing. No `NPM_TOKEN` secret is needed.

Because the model catalog refreshes automatically at runtime, releases are only needed for deprecation handling (`RETIRED_MODEL_IDS` in `scripts/generate-models.ts`) or pricing updates (`OLLAMA_TO_MODELSDEV` in `scripts/generate-pricing.ts`).

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
