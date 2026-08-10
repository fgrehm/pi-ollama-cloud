# pi-ollama-cloud

Ollama Cloud provider plugin for the [Pi](https://pi.dev) coding agent.

Registers Ollama Cloud as a model provider with dynamically fetched models, and provides `ollama_web_search` and `ollama_web_fetch` tools that use the [Ollama Cloud web search API](https://docs.ollama.com/capabilities/web-search) - no local Ollama server required.

## Features

- **Dynamic model discovery** - Fetches the full model list from `ollama.com/v1/models`, then fetches per-model details via `/api/show` to determine capabilities, context length, and tool support.
- **Curated thinking levels** - Maps Pi's thinking levels to Ollama Cloud's OpenAI-compatible `reasoning_effort` values via `thinking-levels.ts`, with per-model exceptions based on API testing.
- **Baked-in model list** - A generated fallback list (`models.generated.ts`) ships with the extension so models are available on first launch without any network calls. It is only a fallback: pi refreshes the live catalog at runtime, so shipping a new release for catalog freshness is no longer needed.
- **Automatic model refresh** - On startup, `/model` open, and `pi update --models`, pi calls the extension's `refreshModels` callback to fetch the latest models from the API and persists them through pi's own model store. No manual refresh command.
- **`ollama_web_search` tool** - Search the web for real-time information using Ollama Cloud's `/api/web_search` endpoint. Returns titles, URLs, and content snippets.
- **`ollama_web_fetch` tool** - Fetch and extract text content from a web page URL using Ollama Cloud's `/api/web_fetch` endpoint. Returns page title, content, and links.
- **Estimated cost tracking** - Models are registered with estimated per-token costs sourced from [models.dev](https://models.dev) (the same catalog pi uses), so Pi's `/cost` shows comparable usage. Ollama Cloud is subscription-billed (Free, Pro, Max), so these are equivalent pay-as-you-go estimates, not actual charges. See [ollama.com/pricing](https://ollama.com/pricing) for plan details.

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

The simplest way is the `/login` command inside Pi: run `/login`, choose **Use an API key**, pick **Ollama Cloud**, and paste your key. Pi stores it in `~/.pi/agent/auth.json` and `/logout` removes it.

Alternatively, set the `OLLAMA_API_KEY` environment variable:

```bash
export OLLAMA_API_KEY="your-key"
```

Or add it to `~/.pi/agent/auth.json` by hand:

```json
{
  "ollama-cloud": {
    "type": "api_key",
    "key": "your-key"
  }
}
```

### 3. Configure the extension (optional)

Extension settings can be set via JSON config files. Project-local settings override global/user-level settings.

| Location | Scope |
|---|---|
| `~/.pi/agent/ollama-cloud.json` | Global / user-level (all projects) |
| `.pi/ollama-cloud.json` | Project-local (takes precedence) |

**Available settings:**

| Setting | Type | Default | Description |
|---|---|---|---|
| `webTools` | boolean | `true` | Set to `false` to prevent `ollama_web_search` and `ollama_web_fetch` from being registered |
| `usageStatus` | boolean | `true` | Set to `false` to hide the footer usage status bar (e.g. if you run your own footer/status extension) |

Example `ollama-cloud.json`:

```json
{
  "webTools": false,
  "usageStatus": false
}
```

The `PI_OLLAMA_WEB_TOOLS` environment variable still works as an override above config files. Set it to `0`, `false`, `no`, or `off` to disable web tools regardless of config file settings.

### 4. Select a model

Use `/model` or `Ctrl+L` to switch to an Ollama Cloud model. Models appear under the `ollama-cloud` provider.

## How it works

The plugin uses two Ollama Cloud API endpoints to build the model list:

1. **`GET https://ollama.com/v1/models`** - Returns a list of all available model IDs.
2. **`POST https://ollama.com/api/show`** - For each model, fetches details including capabilities (`tools`, `thinking`, `vision`) and context length.

Only models with the `tools` capability are registered - these are the ones Pi can use for tool-calling.

The model list refreshes automatically: pi calls the extension's `refreshModels` callback on startup, when `/model` opens, and on `pi update --models`, fetching the live catalog and persisting it through pi's own model store. A model removed from the Ollama Cloud API disappears after the next successful refresh. The baked-in `models.generated.ts` list (regenerated via `npm run generate-models`) is only a first-launch fallback when no persisted catalog exists yet.

The model fetch itself is keyless (the `/v1/models` and `/api/show` endpoints are public), but pi only runs the live refresh when a credential resolves, so a user without a configured API key stays on the baked-in list until they add one. That is a non-issue in practice because a credentialless user cannot run models anyway.

Model metadata is derived from the `/api/show` response:

| Field | Source |
|---|---|
| `reasoning` | `capabilities` includes `"thinking"` |
| `thinkingLevelMap` | [`thinking-levels.ts`](thinking-levels.ts) with 5 maps (DEFAULT, GPT_OSS, QWEN3, GLM_52, NO_OFF) based on API testing |
| `input` | `["text", "image"]` if `capabilities` includes `"vision"`, else `["text"]` |
| `contextWindow` | `model_info.*.context_length` (falls back to 128000) |
| `maxTokens` | Fixed at 32768 |
| `cost` | Estimated per-1M-token prices from [models.dev](https://models.dev), generated by `scripts/generate-pricing.ts` into `pricing.generated.ts`. Ollama Cloud is subscription-billed, so these are equivalent pay-as-you-go estimates, not actual charges. Unmapped models default to zero. Prices are pinned to the installed package version and only update on a new release, so newly added models register with zero cost until then. |

### Thinking level mapping

Pi's thinking levels are mapped to Ollama Cloud's OpenAI-compatible `reasoning_effort` parameter in [`thinking-levels.ts`](thinking-levels.ts). The API accepts `none`, `low`, `medium`, `high`, and `max`. Effects of `max` over `high` vary by model and prompt difficulty - see [`docs/think-experiment.md`](docs/think-experiment.md) for details.

| Map | Models | Levels exposed | Notes |
|---|---|---|---|
| `DEFAULT` | Most thinking models | off, low, medium, high, xhigh | `minimal` hidden (duplicate of low) |
| `GPT_OSS` | `gpt-oss*` | low, medium, high | Can't disable thinking, no off or xhigh |
| `QWEN3` | `qwen3*` (except `qwen3-vl*`) | off, medium | Binary-only (think/nothink), no gradation |
| `GLM_52` | `glm-5.2` | off, high, xhigh | GLM supports disabled thinking; Ollama's model page confirms `high` and `max` reasoning efforts |
| `NO_OFF` | `qwen3-vl*`, `kimi-k2-thinking`, `minimax*` | low, medium, high, xhigh | "none" doesn't disable thinking on these models |

See [docs/think-experiment.md](docs/think-experiment.md) for the testing methodology and results.

## Tools

| Tool | Description |
|---|---|
| `ollama_web_search` | Search the web via Ollama Cloud's `/api/web_search` |
| `ollama_web_fetch` | Fetch a web page via Ollama Cloud's `/api/web_fetch` |

Both tools use the same Ollama Cloud API key configured for the provider. No local Ollama server is needed.

## Commands

| Command | Description |
|---|---|
| `/ollama-webtools [on\|off\|enable\|disable]` | Enable or disable the `ollama_web_search` and `ollama_web_fetch` tools. Toggles if no argument given. |
| `/ollama-cloud-usage` | Show Ollama Cloud session (5h) and weekly (7d) usage limits, per-model request counts, and the 4-week activity cost. |

## Usage status bar

While an `ollama-cloud` model is the active provider, the footer shows a compact
live usage readout (`5h ▕███░░░░░░░▏ 34% 7d ▕████░░░░░░▏ 45%`) that refreshes
every 5 minutes and after each agent turn. Each segment is colored by how close
it is to the cap: green below 60%, yellow at 60-79%, red at 80%+. It reads the
same undocumented `/api/usage` endpoint as `/ollama-cloud-usage` and clears
itself on transient errors or when you switch to a non-Ollama-Cloud provider.

The quota-bar concept is inspired by
[`@entelligentsia/pi-ollama-cloud-usage-tracker`](https://github.com/Entelligentsia/pi-ollama-cloud-usage-tracker),
but this extension fetches usage from the `/api/usage` endpoint with the API key
it already resolves, rather than scraping the settings page with Chrome cookies.

## Development

```bash
npm install          # install devDependencies
npm run check        # lint + format + type-check (auto-fix)
npm run lint         # lint only (no fixes)
npm run typecheck    # type-check only (tsgo --noEmit)
npm run format       # format only
```

The project uses [Biome](https://biomejs.dev/) for linting and formatting (2-space indent, line width 120) and [tsgo](https://github.com/microsoft/typescript-go) for type-checking.

### Testing local changes

Static checks (no API key needed):

```bash
npm install
npm run check        # lint + format + type-check
npm run test         # unit tests
```

Live smoke against the real API (needs an `OLLAMA_API_KEY` or an `ollama-cloud` entry in `auth.json`):

```bash
# Run pi with the local extension, no install required. The --no-* flags isolate
# the run from other installed extensions, skills, prompt templates, themes,
# context files, and session storage so only the local checkout is exercised
pi --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files -e ./index.ts \
   --model "ollama-cloud/glm-5.2" --no-tools

# Run pi with the local extension, no install required. The --no-* flags isolate
# the run from other installed extensions, skills, prompt templates, themes,
# context files, and session storage so only the local checkout is exercised
pi --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-session \
  -e ./index.ts --model "ollama-cloud/gemma4:31b" --no-tools -p "Say hi in one word"

# Verify thinking is suppressed when off
pi --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-session \
  -e ./index.ts --thinking off --model "ollama-cloud/glm-5.2" --no-tools --mode json -p 'hi'

# Web tools
npm run smoke:web-tools
```

The `-e`/`--extension` flag loads the extension from the local checkout without installing it; `--no-extensions` disables all other extension discovery so the run cannot pick up an installed `pi-ollama-cloud` or other plugins. The same commands run in CI (`.github/workflows/test.yml`), gated on the `OLLAMA_CLOUD_API_KEY` secret.

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
| **Setup effort** | One command: `ollama launch pi` | Install extension + API key |
| **Use when** | You're already running Ollama locally and want the default experience | You don't want to run a local server, or want a standalone cloud-only provider alongside your local setup |

**You can use both at the same time.** The providers live under different names (`ollama` vs `ollama-cloud`), so you can switch between them with `/model` or `Ctrl+L`. For example, use your local `ollama` provider for low-latency work on smaller models, and `ollama-cloud` for direct access to the full catalog of cloud models without needing a local server.

> **Note:** The [`@ollama/pi-web-search`](https://www.npmjs.com/package/@ollama/pi-web-search) package (installed automatically by `ollama launch pi`) calls the **local** Ollama server's `/api/experimental/web_search` and `/api/experimental/web_fetch` endpoints and authenticates via `ollama signin`. This extension's `ollama_web_search` and `ollama_web_fetch` tools use the **cloud** API at `ollama.com/api/web_search` and `ollama.com/api/web_fetch` instead - same API key, no local server required. Both can coexist: the local tools register as `web_search`/`web_fetch` and these register as `ollama_web_search`/`ollama_web_fetch` to avoid name conflicts.

## Releasing

Publishing a new version to npm is a two-command process:

```bash
# 1. Bump version and create a git tag in one step
npm version minor   # or patch, or major
# 2. Push the tag to trigger the GitHub Actions publish workflow
git push --tags
```

Because the model catalog refreshes automatically at runtime, a release is **not** needed to ship new models. Publish only when:

- A model is retired and still listed by the API: add it to `RETIRED_MODEL_IDS` in `scripts/generate-models.ts` (check https://docs.ollama.com/cloud#retirements, then regenerate `models.generated.ts`).
- Pricing changes: models.dev prices updated, or a new model needs an `OLLAMA_TO_MODELSDEV` mapping line (regenerate `pricing.generated.ts`).

The tag version must match the version in `package.json` - `npm version` handles this automatically. The workflow at `.github/workflows/publish.yml` verifies the match before publishing to npm.

The workflow uses npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC) - no tokens stored as secrets. To set it up:

1. Go to [npmjs.com](https://www.npmjs.com) → your avatar → **Packages** → `pi-ollama-cloud` → **Settings** → **Trusted publishing**
2. Click **GitHub Actions** and enter:
   - **Workflow filename**: `publish.yml`
3. Save

Each publish also gets automatic [provenance attestation](https://docs.npmjs.com/generating-provenance-statements).

## Upgrading

Since 0.8.0:

- The `/ollama-cloud-refresh` command is removed. Models refresh automatically on startup, `/model` open, and `pi update --models`.
- The old cache file at `~/.pi/agent/cache/ollama-cloud-models.json` is orphaned. Delete it manually: `rm ~/.pi/agent/cache/ollama-cloud-models.json`.
- Requires a pi version with the native `refreshModels` API (pi 0.84.0+).

## Notes

- The fetch timeout is 10 seconds per request. On slow connections, some model detail fetches may time out; the refresh uses whatever succeeded and only fails if every model detail fetch fails.
- `deepseek-v4` occasionally emits raw `<｜DSML｜tool_calls｜>` markup as plain text instead of structured tool calls, then stops. This is DeepSeek's native tool-call format leaking through Ollama Cloud's OpenAI-compatible endpoint, so it looks like an upstream Ollama issue rather than something this extension can fix. If you hit it, retry or switch models.
