/**
 * Ollama Cloud usage data plane: fetch and format /api/usage.
 *
 * Self-contained module. Depends on:
 *   - models.ts - only for OLLAMA_BASE URL constant
 *   - utils.ts  - fetchJsonWithTimeout
 * Does NOT depend on provider registration, model fetching, or API key
 * resolution (the caller resolves the key and passes it in).
 *
 * The /api/usage endpoint is undocumented and could change or disappear. The
 * fetch degrades gracefully: distinct HTTP statuses map to distinct
 * user-facing errors, and a malformed body raises a clear error rather than
 * crashing.
 */

import { OLLAMA_BASE } from "./models.ts";
import { fetchJsonWithTimeout } from "./utils.ts";

// --- Types ---

export interface UsageModel {
  name: string;
  request_count: number;
}

export interface UsageLimit {
  /** Fraction of the plan's cap, 0-1 (not tokens). */
  usage: number;
  /** Per-model request counts (not token counts). */
  models: UsageModel[];
}

export interface UsageActivity {
  cost?: string;
  period?: {
    type?: string;
    starting_at?: string;
    ending_at?: string;
  };
}

export interface UsageData {
  limits: {
    session: UsageLimit;
    weekly: UsageLimit;
  };
  activity?: UsageActivity;
}

// --- Constants ---

const USAGE_TIMEOUT_MS = 10000;

// --- Validation ---

/** Validate a single usage limit: a 0-1 fraction plus per-model request counts. */
export function isUsageLimit(data: unknown): data is UsageLimit {
  if (data == null || typeof data !== "object") return false;
  const d = data as UsageLimit;
  return (
    typeof d.usage === "number" &&
    Array.isArray(d.models) &&
    d.models.every(
      (m) =>
        m != null &&
        typeof m === "object" &&
        typeof (m as UsageModel).name === "string" &&
        typeof (m as UsageModel).request_count === "number",
    )
  );
}

/** Validate a parsed /api/usage response: must have session and weekly limits. */
export function isUsageResponse(data: unknown): data is UsageData {
  if (data == null || typeof data !== "object") return false;
  const d = data as UsageData;
  return (
    d.limits != null && typeof d.limits === "object" && isUsageLimit(d.limits.session) && isUsageLimit(d.limits.weekly)
  );
}

// --- Fetch ---

/** Throw a usage error for a non-ok result, mapping distinct status codes. */
function usageError(status: number, error?: string): never {
  if (status === 401 || status === 403) {
    throw new Error(
      "Ollama Cloud usage failed: authentication error. " + "Check your API key in OLLAMA_API_KEY or auth.json.",
    );
  }
  if (status === 429) {
    throw new Error("Ollama Cloud usage failed: rate limited. Try again shortly.");
  }
  if (status === 404) {
    throw new Error(
      "Ollama Cloud usage failed: the /api/usage endpoint is unavailable (status 404). " +
        "It is undocumented and may have changed.",
    );
  }
  if (status >= 500) {
    throw new Error(`Ollama Cloud usage failed: server error (status ${status}). Try again shortly.`);
  }
  throw new Error(
    `Ollama Cloud usage failed: unexpected response (status ${status}${error ? `: ${error}` : ""}). Try again shortly.`,
  );
}

/**
 * Fetch Ollama Cloud usage from the undocumented /api/usage endpoint.
 * The caller resolves the API key and passes it in.
 */
export async function fetchUsage(apiKey: string, externalSignal?: AbortSignal): Promise<UsageData> {
  const res = await fetchJsonWithTimeout<UsageData>(
    `${OLLAMA_BASE}/api/usage`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    USAGE_TIMEOUT_MS,
    externalSignal,
  );

  if (!res.ok) {
    usageError(res.status, res.error);
  }
  if (!isUsageResponse(res.data)) {
    throw new Error("Ollama Cloud usage failed: unexpected response shape from the API.");
  }
  return res.data;
}

// --- Formatting ---

/** Format usage for the /ollama-cloud-usage command output. */
export function formatUsage(data: UsageData): string {
  const lines: string[] = ["Ollama Cloud usage:"];

  const sessionPct = Math.round(data.limits.session.usage * 100);
  lines.push(`  Session (5h): ${sessionPct}%`);
  for (const m of data.limits.session.models) {
    lines.push(`    - ${m.name}: ${m.request_count} request${m.request_count === 1 ? "" : "s"}`);
  }

  const weeklyPct = Math.round(data.limits.weekly.usage * 100);
  lines.push(`  Weekly (7d): ${weeklyPct}%`);
  for (const m of data.limits.weekly.models) {
    lines.push(`    - ${m.name}: ${m.request_count} request${m.request_count === 1 ? "" : "s"}`);
  }

  if (data.activity?.cost) {
    lines.push(`  Activity (4wk): $${data.activity.cost}`);
  }

  return lines.join("\n");
}

/** Compact one-line usage for the footer status bar. */
export function formatUsageStatus(data: UsageData): string {
  const session = Math.round(data.limits.session.usage * 100);
  const weekly = Math.round(data.limits.weekly.usage * 100);
  return `5h ${session}% 7d ${weekly}%`;
}
