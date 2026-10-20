# Web tools

`ollama_web_search` and `ollama_web_fetch` use Ollama Cloud's [web search API](https://docs.ollama.com/capabilities/web-search) with the provider's configured API key. No local Ollama server is required.

## Search

Search returns up to 5 results by default (`max_results`, maximum 10) with a title, URL, and snippet. Snippets are 500 characters by default. Full result content is cached, so `expand=<index>` can return a result's full content without another API call. The search cache key includes `max_results`.

## Fetch

Fetch returns the page title, text, and links. Long pages are returned in 3000-character chunks. Use `offset=N` to continue from a character offset, or `full=true` to return the remainder at once.

Both tools accept `refresh=true` to bypass the cache, including a cached failure. Errors identify likely causes and next steps. Authentication (401/403), rate-limit (429), transport, and server errors are not cached.

## Cache

Successful searches and page fetches are cached for 24 hours. Failed page fetches are cached for 15 minutes, except auth, rate-limit, transport, and server errors. Expired entries are pruned on write. The cache is capped at 500 entries per kind, 256 KiB per serialized entry, and 8 MiB total. The oldest entries are evicted first. Oversized content remains available for the current call but is not persisted.

The cache file is stored under `~/.pi/agent/cache/pi-ollama-cloud/cache.json` by default and written with `0600` permissions. It contains page content and raw URLs, which may include sensitive query parameters. Avoid fetching URLs containing secrets or configure a custom cache path. Concurrent Pi processes use last-writer-wins updates, which can cause redundant API calls.

| Environment variable | Default | Description |
|---|---:|---|
| `PI_OLLAMA_SEARCH_TTL_HOURS` | `24` | Successful result cache lifetime. |
| `PI_OLLAMA_SEARCH_FAIL_TTL_MINUTES` | `15` | Failed page cache lifetime. |
| `PI_OLLAMA_SEARCH_CACHE_PATH` | Agent cache path | Override the cache file path. |
| `PI_OLLAMA_SEARCH_MAX_ENTRIES` | `500` | Maximum entries per tool kind. |
| `PI_OLLAMA_SEARCH_SNIPPET_CHARS` | `500` | Search snippet length. |
| `PI_OLLAMA_SEARCH_CHUNK_CHARS` | `3000` | Fetch chunk size. |
