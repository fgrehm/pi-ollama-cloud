# Usage status and API

## Usage commands and status bar

`/ollama-cloud-usage` displays the current quota or included balance, renewal date and purchased credits when returned, and request totals when available. It uses Ollama's documented [`/api/balance`](https://docs.ollama.com/api/balance) endpoint and the documented [`/api/usage`](https://docs.ollama.com/api/cloud-usage) request histogram.

The footer status bar is enabled only while an `ollama-cloud` model is active. It is off by default. Enable it with `/ollama-usage-status on` or set `"usageStatus": true` in `ollama-cloud.json`. The bar refreshes at most every five minutes, including after an agent turn, and is cleared on provider switch or transient errors.

## Reuse the usage API

The package exports helpers for custom status bars and extensions:

```ts
import { fetchUsage, fetchUsageStats, formatUsage, formatUsageStatusColored } from "pi-ollama-cloud/usage.ts";
import { getCloudApiKey } from "pi-ollama-cloud/utils.ts";
import type { UsageData } from "pi-ollama-cloud/usage.ts";

const apiKey = await getCloudApiKey(ctx);
const data = await fetchUsage(apiKey);
ctx.ui.setStatus("my-usage", formatUsageStatusColored(ctx.ui.theme, data));
```

| Export | Description |
|---|---|
| `fetchUsage(apiKey, signal?)` | Fetch quota and allowance data. `UsageData.included.period.until` contains the renewal boundary when provided. |
| `formatUsageStatusColored(theme, data)` | Format a one-line colored quota bar. |
| `fetchUsageStats(apiKey, range?, signal?)` | Fetch request histogram data (limited to 10 requests per minute per user). |
| `formatUsage(data, stats?)` | Format quota, billing period, and optional request totals. |
| `getCloudApiKey(ctx)` | Resolve the configured Ollama Cloud key. |
| `isUsageResponse(data)` / `isUsageStats(data)` | Validate raw API responses. |

The package ships TypeScript sources without a build step. Submodule imports include the `.ts` extension.
