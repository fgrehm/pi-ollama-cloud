import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // Link an external abort signal (e.g. a tool's cancellation signal) so the
  // request aborts on either the timeout or the caller aborting. Cleanup runs
  // in the finally block on both the happy and error paths.
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let data: T | null = null;
    try {
      data = text ? (JSON.parse(text) as T) : null;
    } catch {
      // Keep data null and report text below.
    }
    const error =
      data && typeof data === "object" && "error" in data
        ? typeof (data as { error: unknown }).error === "object"
          ? JSON.stringify((data as { error: unknown }).error)
          : String((data as { error: unknown }).error)
        : text;
    return { ok: res.ok, status: res.status, data, error: res.ok ? undefined : error };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
    if (externalSignal && !externalSignal.aborted) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

export async function concurrentMap<T, R>(
  items: T[],
  workers: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, workers) }, async () => {
      while (next < items.length) {
        const index = next++;
        try {
          results[index] = { status: "fulfilled", value: await fn(items[index]) };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    }),
  );
  return results;
}

export function getContextLength(modelInfo: Record<string, unknown>): number {
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(".context_length") && typeof value === "number") {
      return value;
    }
  }
  return 128000;
}

/**
 * Resolve the Ollama Cloud API key for a tool execution or command.
 *
 * Prefers the canonical provider auth chain (ctx.modelRegistry.getApiKeyForProvider),
 * which honors runtime/CLI key overrides, the registered
 * apiKey: "$OLLAMA_API_KEY" config, and stored auth.json credentials. Falls back
 * to the OLLAMA_API_KEY env var for the case where the provider is not yet
 * registered at call time.
 */
export async function getCloudApiKey(ctx: Pick<ExtensionContext, "modelRegistry">): Promise<string | undefined> {
  return (await ctx.modelRegistry.getApiKeyForProvider("ollama-cloud")) ?? process.env.OLLAMA_API_KEY;
}

/**
 * Throw a user-facing error for a non-ok Ollama Cloud HTTP response, mapping
 * distinct status codes. Shared by the web tools and the usage command.
 */
export function httpError(op: string, status: number, error?: string): never {
  if (status === 401 || status === 403) {
    throw new Error(
      `Ollama Cloud ${op} failed: authentication error. Check your API key in OLLAMA_API_KEY or auth.json.`,
    );
  }
  if (status === 429) {
    throw new Error(`Ollama Cloud ${op} failed: rate limited. Try again shortly.`);
  }
  if (status >= 500) {
    throw new Error(`Ollama Cloud ${op} failed: server error (status ${status}). Try again shortly.`);
  }
  throw new Error(
    `Ollama Cloud ${op} failed: unexpected response (status ${status}${error ? `: ${error}` : ""}). Try again shortly.`,
  );
}

/** Parse a positive-integer env var, falling back when unset or invalid (NaN, non-integer, <= 0). */
export function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
