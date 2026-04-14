# pi-ollama-cloud

Ollama Cloud provider plugin for [Pi](https://github.com/badlogic/pi-mono) coding agent.

Dynamically fetches available models from [ollama.com](https://ollama.com), filters to those with tool-calling support, and registers them as an `ollama-cloud` provider using the OpenAI completions API.

## Features

- **Dynamic model discovery** - Fetches the full model list from `ollama.com/v1/models`, then fetches per-model details via `/api/show` to determine capabilities, context length, and tool support.
- **Persistent cache** - Raw API responses are cached at `~/.pi/agent/cache/ollama-cloud-models.json` so models are available immediately on startup without hitting the network.
- **Cold cache fallback** - When no cache exists, a small set of hardcoded models is used until `/ollama-cloud-refresh` is run.
- **`/ollama-cloud-refresh` command** - Re-fetches the model list from the API and updates the cache and provider registration live (no restart needed).
- **Zero cost tracking** - All models are registered with zero costs since Ollama Cloud pricing is not exposed via the API.

## Prerequisites

- An [Ollama Cloud API key](https://ollama.com)

## Installation

### Option 1: `pi install` (recommended)

```bash
pi install git:github.com/fgrehm/pi-ollama-cloud
```

This clones the repo to `~/.pi/agent/git/` and adds it to your settings. Run `pi update` to get new versions.

For project-local install (stored in `.pi/git/`):

```bash
pi install git:github.com/fgrehm/pi-ollama-cloud --local
```

### Option 2: `-e` flag (try without installing)

```bash
pi -e /path/to/pi-ollama-cloud
```

### Option 3: Clone manually (if you want to make changes and "try it live")

Pi auto-discovers subdirectories under `~/.pi/agent/extensions/`:

```bash
git clone git@github.com:fgrehm/pi-ollama-cloud.git ~/.pi/agent/extensions/pi-ollama-cloud
```

## Setup

### 1. Get an API key

Sign up at [ollama.com](https://ollama.com) and generate an API key.

### 2. Configure the API key

Either set the `OLLAMA_API_KEY` environment variable:

```bash
export OLLAMA_API_KEY="your-key"
```

Or add it to `~/.pi/agent/auth.json`:

```json
{
  "ollama-cloud": {
    "type": "api_key",
    "key": "your-key"
  }
}
```

### 3. Fetch models

On first launch the plugin will use a small set of fallback models. Run:

```
/ollama-cloud-refresh
```

This fetches the full model list from the Ollama Cloud API and caches it locally.

### 4. Select a model

Use `/model` or `Ctrl+L` to switch to an Ollama Cloud model. Models appear under the `ollama-cloud` provider.

## How it works

The plugin uses two Ollama Cloud API endpoints to build the model list:

1. **`GET https://ollama.com/v1/models`** - Returns a list of all available model IDs.
2. **`POST https://ollama.com/api/show`** - For each model, fetches details including capabilities (`tools`, `thinking`, `vision`) and context length.

Only models with the `tools` capability are registered - these are the ones Pi can use for tool-calling.

The raw `/api/show` responses are cached at `~/.pi/agent/cache/ollama-cloud-models.json`. This cache **never expires** - run `/ollama-cloud-refresh` to update it.

Model metadata is derived from the cached data:

| Field | Source |
|---|---|
| `reasoning` | `capabilities` includes `"thinking"` |
| `input` | `["text", "image"]` if `capabilities` includes `"vision"`, else `["text"]` |
| `contextWindow` | `model_info.*.context_length` (falls back to 128000) |
| `maxTokens` | Fixed at 32768 |
| `cost` | All zeros (Ollama Cloud pricing is not exposed via API) |

## Commands

| Command | Description |
|---|---|
| `/ollama-cloud-refresh` | Fetch models from the Ollama Cloud API, update cache, and re-register the provider |

## Development

```bash
npm install          # install devDependencies (biome)
npm run check        # lint + format with auto-fix
npm run lint        # lint only (no fixes)
npm run format      # format only
```

The project uses [Biome](https://biomejs.dev/) for linting and formatting (2-space indent, line width 120).

## Notes

- Some Ollama Cloud models may reject the `developer` message role, causing a `400` error. If you encounter this, the model may need `compat: { supportsDeveloperRole: false }`. You can edit `index.ts` to add this for specific models, or open an issue to track it.
- The fetch timeout is 10 seconds per request. On slow connections, some model detail fetches may time out - the plugin reports how many succeeded vs failed.
