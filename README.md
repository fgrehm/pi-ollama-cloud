# pi-ollama-cloud

Ollama Cloud provider plugin for [Pi](https://github.com/badlogic/pi-mono) coding agent.

Registers Ollama Cloud as a model provider with dynamically fetched models, and provides `ollama_web_search` and `ollama_web_fetch` tools that use the [Ollama Cloud web search API](https://docs.ollama.com/capabilities/web-search) — no local Ollama server required.

## Features

- **Dynamic model discovery** - Fetches the full model list from `ollama.com/v1/models`, then fetches per-model details via `/api/show` to determine capabilities, context length, and tool support.
- **Persistent cache** - Raw API responses are cached at `~/.pi/agent/cache/ollama-cloud-models.json` so models are available immediately on startup without hitting the network.
- **Cold cache fallback** - When no cache exists, a small set of hardcoded models is used until `/ollama-cloud-refresh` is run.
- **`/ollama-cloud-refresh` command** - Re-fetches the model list from the API and updates the cache and provider registration live (no restart needed).
- **`ollama_web_search` tool** - Search the web for real-time information using Ollama Cloud's `/api/web_search` endpoint. Returns titles, URLs, and content snippets.
- **`ollama_web_fetch` tool** - Fetch and extract text content from a web page URL using Ollama Cloud's `/api/web_fetch` endpoint. Returns page title, content, and links.
- **Zero cost tracking** - All models are registered with zero costs since Ollama Cloud uses a flat subscription model (Free, Pro, Max) rather than per-token billing. Per-request costs don't apply, so Pi's cost tracker always shows zero. See [ollama.com/pricing](https://ollama.com/pricing) for plan details.

## Prerequisites

- An [Ollama Cloud API key](https://ollama.com)

## Installation

### Option 1: from npm (recommended)

```bash
pi install npm:pi-ollama-cloud
```

This installs the latest published version from npm. Run `pi update` to get new versions.

### Option 2: from git

```bash
pi install git:github.com/fgrehm/pi-ollama-cloud
```

This clones the repo to `~/.pi/agent/git/` and adds it to your settings.

For project-local install (stored in `.pi/git/`):

```bash
pi install git:github.com/fgrehm/pi-ollama-cloud --local
```

### Option 3: `-e` flag (try without installing)

```bash
pi -e npm:pi-ollama-cloud
```

### Option 4: Clone manually (if you want to make changes and "try it live")

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
| `cost` | All zeros (Ollama Cloud uses subscription plans, not per-token billing - see [pricing](https://ollama.com/pricing)) |

## Tools

| Tool | Description |
|---|---|
| `ollama_web_search` | Search the web via Ollama Cloud's `/api/web_search` |
| `ollama_web_fetch` | Fetch a web page via Ollama Cloud's `/api/web_fetch` |

Both tools use the same Ollama Cloud API key configured for the provider. No local Ollama server is needed.

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

## How is this different from `ollama launch pi`?

[`ollama launch pi`](https://docs.ollama.com/integrations/pi) is Ollama's built-in one-command setup that configures Pi to talk to your **local Ollama server**. Both local and cloud models work - cloud models (e.g. `qwen3.5:cloud`) are proxied through your local server to `ollama.com`. This extension takes a different approach: it connects Pi **directly** to Ollama's hosted API at `ollama.com`, bypassing the local server entirely.

| | `ollama launch pi` | `pi-ollama-cloud` |
|---|---|---|
| **Provider name** | `ollama` | `ollama-cloud` |
| **Endpoint** | Local Ollama server (`http://localhost:11434/v1`) | Ollama Cloud (`https://ollama.com/v1`) |
| **Local models** | ✅ Run on your machine | ❌ Not available |
| **Cloud models** | ✅ Proxied through local server (e.g. `qwen3.5:cloud`) | ✅ Connected directly |
| **Local Ollama required?** | Yes - must be installed and running | No - works without any local server |
| **Authentication** | Handled by the local server (sign-in flow via `ollama`) | Ollama Cloud API key (set via `OLLAMA_API_KEY` or `auth.json`) |
| **Model discovery** | Interactive picker with curated recommendations + pulled models | Dynamic - fetches all available cloud models with tool support from the API |
| **Web tools** | Auto-installed (`@ollama/pi-web-search`) when cloud is enabled | ✅ Built-in: `ollama_web_search` and `ollama_web_fetch` use the [Ollama Cloud web search API](https://docs.ollama.com/capabilities/web-search) directly (same API key, no local server needed) |
| **Setup effort** | One command: `ollama launch pi` | Install extension + API key + `/ollama-cloud-refresh` |
| **Use when** | You're already running Ollama locally and want the default experience | You don't want to run a local server, or want a standalone cloud-only provider alongside your local setup |

**You can use both at the same time.** The providers live under different names (`ollama` vs `ollama-cloud`), so you can switch between them with `/model` or `Ctrl+L`. For example, use your local `ollama` provider for low-latency work on smaller models, and `ollama-cloud` for direct access to the full catalog of cloud models without needing a local server.

> **Note:** The [`@ollama/pi-web-search`](https://www.npmjs.com/package/@ollama/pi-web-search) package (installed automatically by `ollama launch pi`) calls the **local** Ollama server's `/api/experimental/web_search` and `/api/experimental/web_fetch` endpoints and authenticates via `ollama signin`. This extension's `ollama_web_search` and `ollama_web_fetch` tools use the **cloud** API at `ollama.com/api/web_search` and `ollama.com/api/web_fetch` instead — same API key, no local server required. Both can coexist: the local tools register as `web_search`/`web_fetch` and these register as `ollama_web_search`/`ollama_web_fetch` to avoid name conflicts.

## Releasing

Publishing a new version to npm is a two-command process:

```bash
# 1. Bump version and create a git tag in one step
npm version minor   # or patch, or major
# 2. Push the tag to trigger the GitHub Actions publish workflow
git push --tags
```

The tag version must match the version in `package.json` — `npm version` handles this automatically. The workflow at `.github/workflows/publish.yml` verifies the match before publishing to npm.

The workflow uses npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC) — no tokens stored as secrets. To set it up:

1. Go to [npmjs.com](https://www.npmjs.com) → your avatar → **Packages** → `pi-ollama-cloud` → **Settings** → **Trusted publishing**
2. Click **GitHub Actions** and enter:
   - **Workflow filename**: `publish.yml`
3. Save

Each publish also gets automatic [provenance attestation](https://docs.npmjs.com/generating-provenance-statements).

## Notes

- Some Ollama Cloud models may reject the `developer` message role, causing a `400` error. If you encounter this, the model may need `compat: { supportsDeveloperRole: false }`. You can edit `index.ts` to add this for specific models, or open an issue to track it.
- The fetch timeout is 10 seconds per request. On slow connections, some model detail fetches may time out - the plugin reports how many succeeded vs failed.
