# Development

## Checks and tests

```bash
npm install
npm run check   # Biome lint/format and TypeScript type-check (auto-fixes formatting)
npm run test    # unit tests
```

The project uses [Biome](https://biomejs.dev/) and [tsgo](https://github.com/microsoft/typescript-go). Do not run `npm run build`; the package ships TypeScript sources as-is.

## Local extension smoke tests

Static checks require no API key. Live API tests require `OLLAMA_API_KEY` or an `ollama-cloud` credential in Pi's `auth.json`.

```bash
# Chat request against a local checkout, isolated from other user extensions and settings
pi --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-session \
  -e ./index.ts --model "ollama-cloud/gemma4:31b" --no-tools -p "Say hi in one word"

# Confirm the off thinking level is respected
pi --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-session \
  -e ./index.ts --thinking off --model "ollama-cloud/glm-5.2" --no-tools --mode json -p 'hi'

# Live web-tool smoke (requires a key)
npm run smoke:web-tools
```

CI runs the static checks and tests; the web-tool smoke is gated on the `OLLAMA_CLOUD_API_KEY` secret. The `-e ./index.ts` flag loads this checkout, while `--no-extensions` prevents another installed copy from being loaded.

## Generated data

Generated files are maintained by scripts; do not hand-edit them:

- `npm run generate-models` refreshes pricing, reasoning metadata, and the baked-in model fallback from their upstream sources.
- `npm run generate-limits` probes the live API for max output tokens. It reads Pi's `auth.json` or `OLLAMA_API_KEY`; append a model ID to probe only that model.

The generated files describe different sets: the baked-in catalog contains successfully assembled tool-capable models, pricing covers all live API model IDs, limits include models with known/probed values, and reasoning metadata follows models.dev. Their counts need not match. See [AGENTS.md](../AGENTS.md) for generator ownership and detailed conventions.
