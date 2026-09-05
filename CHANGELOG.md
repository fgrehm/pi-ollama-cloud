# CHANGELOG

All notable changes to this project will be documented in this file.

## [Unreleased]

- Cache `ollama_web_search` results (24h) and `ollama_web_fetch` pages (24h success / 15 min failure) on disk under the pi agent home, so repeated queries and page reads cost 0 API calls. Expired entries are pruned on write and a partially corrupted cache file is validated per entry and degrades to "no cache" instead of crashing tool calls. Tune with `PI_OLLAMA_SEARCH_TTL_HOURS`, `PI_OLLAMA_SEARCH_FAIL_TTL_MINUTES`, and `PI_OLLAMA_SEARCH_CACHE_PATH`.
- Bound web tool context usage: search snippets truncate to 500 chars with `[truncated]`/`[complete]` markers, `expand=<index>` returns a truncated result's full content from the cached search (0 extra API calls), and `ollama_web_fetch` pages long pages in 3000-char chunks via `offset`/`full` with a `Continue:` hint for the next offset (`PI_OLLAMA_SEARCH_SNIPPET_CHARS`/`PI_OLLAMA_SEARCH_CHUNK_CHARS` to tune).
- Add `refresh=true` to both web tools to bypass the cache (including a cached failure) and re-call the API; the fresh result replaces the cache entry.
- Failed page fetches are negative-cached for 15 min with a diagnostic message (likely cause + next steps) instead of a bare error. Auth (401/403), rate-limit (429), and transport (timeout/abort/network) failures are never cached — search reports transport errors as `transport error` instead of a confusing `status 0` — so retrying after a fixed key, an expired rate-limit window, or a transient blip re-calls the API immediately.

