# pi-ollama-cloud

An [Ollama Cloud](https://ollama.com) provider extension for the [Pi](https://pi.dev) coding agent. It connects directly to Ollama Cloud, so no local Ollama server is required.

## Features

- Automatically discovers available Ollama Cloud chat models and refreshes Pi's model catalog.
- Adds `ollama_web_search` and `ollama_web_fetch` tools using Ollama Cloud's web API.
- Optionally displays Ollama Cloud usage in the footer and provides a usage command.
- Reports comparable per-token costs in Pi. Ollama Cloud is subscription/credit billed, so `/cost` values are estimates, not actual charges.

## Requirements

- Pi 0.84.0 or later.
- An [Ollama Cloud API key](https://ollama.com/settings/keys).

## Install

```bash
pi install npm:pi-ollama-cloud
```

To try it without installing:

```bash
pi -e npm:pi-ollama-cloud
```

Other install options are available in the [Pi extension docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).

## Setup

In Pi, run `/login`, choose **Use an API key**, select **Ollama Cloud**, and paste your key. Pi stores it in `~/.pi/agent/auth.json`. Alternatively, set `OLLAMA_API_KEY` in the environment before starting Pi.

Select a model with `/model` or `Ctrl+L`. Models refresh automatically on startup, when `/model` opens, and with `pi update --models`. A credential must be configured for Pi to run the live refresh. Only models suitable for chat and advertising tool support are offered.

### Optional settings

Settings can be placed in `~/.pi/agent/ollama-cloud.json` (user-wide) or `.pi/ollama-cloud.json` (project-local, takes precedence).

```json
{
  "webTools": true,
  "usageStatus": false
}
```

| Setting | Default | Description |
|---|---:|---|
| `webTools` | `true` | Register the web search and fetch tools. |
| `usageStatus` | `false` | Show the usage status bar by default. |

`PI_OLLAMA_WEB_TOOLS=0` (also `false`, `no`, or `off`) disables web tools regardless of config.

## Tools and commands

The web tools use the configured Ollama Cloud key directly. Search returns snippets and can expand cached results; fetch returns page text in chunks. Results are cached on disk for 24 hours. Use `refresh=true` to bypass the cache. Cache location, size limits, and paging options are documented under [Web tool details](docs/web-tools.md).

| Command | Description |
|---|---|
| `/ollama-webtools [on\|off\|enable\|disable]` | Enable or disable the web tools. |
| `/ollama-cloud-usage` | Show quota or balance, renewal date when available, purchased credits, and request totals when available. |
| `/ollama-usage-status [on\|off\|enable\|disable]` | Enable or disable the footer usage bar. |

The usage bar is off by default. It refreshes at most every five minutes and is cleared when switching away from Ollama Cloud. See [Usage details](docs/usage.md) for its behavior and the exported API for custom status bars.

## Model and cost notes

Pi refreshes the live model catalog and stores it in its own model store. The generated model list included with the extension is only a first-launch fallback. Models that use a different protocol, such as Ollama's Clef decision models served through `/v1/systemone`, are excluded from the chat model picker.

Pi's `/cost` uses the published rates from [ollama.com/pricing](https://ollama.com/pricing) as comparable per-token estimates. They are not actual subscription charges. Models without a published price report zero cost. The completion API does not report cached-token usage, so cost estimates cannot account for cache hits.

## Troubleshooting

- **No models appear:** configure an API key and reopen `/model`. Pi only runs the live catalog refresh when credentials are available.
- **A refresh is incomplete:** individual model detail requests can time out; successful models are retained. Retry later if the desired model is missing.
- **DeepSeek tool calls show raw markup:** some DeepSeek responses leak native tool-call markup through the OpenAI-compatible endpoint. Retry or switch models.

For changes, tests, live smoke tests, and release instructions, see the [development guide](docs/development.md) and [release guide](docs/releasing.md).

## Difference from `ollama launch pi`

`ollama launch pi` configures Pi to use a local Ollama server, which can proxy cloud models. This extension connects directly to `ollama.com` and does not require a local server. The two providers can be used together: local Ollama models appear under `ollama`, while this extension's cloud models appear under `ollama-cloud`.
