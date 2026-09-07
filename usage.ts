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
 *
 * The response shape has flipped twice: through 2026-09-02 it carried
 * limits.session and limits.weekly, on 2026-09-03 it switched to a single
 * limits.monthly bucket (0.10.0 adapted to that), and by 2026-09-07 it
 * returned session and weekly again. All three buckets are therefore optional
 * and whichever are present are displayed.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { OLLAMA_BASE } from "./models.ts";
import { fetchJsonWithTimeout, httpError } from "./utils.ts";

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
  models?: UsageModel[];
}

export interface UsageData {
  limits: {
    /** Monthly (30d) bucket, served by the API between 2026-09-03 and 2026-09-07. */
    monthly?: UsageLimit;
    /** Session (5h) bucket, served before 2026-09-03 and again as of 2026-09-07. */
    session?: UsageLimit;
    /** Weekly (7d) bucket, served before 2026-09-03 and again as of 2026-09-07. */
    weekly?: UsageLimit;
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

/**
 * Validate a parsed /api/usage response: needs at least one valid limit bucket.
 * The endpoint is undocumented and flips shape unpredictably (monthly-only,
 * session+weekly, possibly other combinations), so any bucket present alone or
 * in any combination is accepted and rendered.
 */
export function isUsageResponse(data: unknown): data is UsageData {
  if (data == null || typeof data !== "object") return false;
  const d = data as UsageData;
  if (d.limits == null || typeof d.limits !== "object") return false;
  return isUsageLimit(d.limits.monthly) || isUsageLimit(d.limits.session) || isUsageLimit(d.limits.weekly);
}

// --- Fetch ---

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
    // The 404 case is specific to this undocumented endpoint: it may have
    // changed or disappeared, so surface that distinctly before the shared
    // status mapping.
    if (res.status === 404) {
      throw new Error(
        "Ollama Cloud usage failed: the /api/usage endpoint is unavailable (status 404). " +
          "It is undocumented and may have changed.",
      );
    }
    httpError("usage", res.status, res.error);
  }
  if (!isUsageResponse(res.data)) {
    throw new Error("Ollama Cloud usage failed: unexpected response shape from the API.");
  }
  return res.data;
}

// --- Formatting ---

/** Clamp a 0-1 usage fraction to a 0-100 percentage for display. */
function usagePercent(usage: number): number {
  if (!Number.isFinite(usage)) return 0;
  return Math.min(Math.max(Math.round(usage * 100), 0), 100);
}

/** The limit buckets present in a response, in display order. */
function limitSegments(data: UsageData): Array<{ label: string; short: string; limit: UsageLimit }> {
  const segs: Array<{ label: string; short: string; limit: UsageLimit }> = [];
  if (data.limits.session != null) {
    segs.push({ label: "Session (5h)", short: "5h", limit: data.limits.session });
  }
  if (data.limits.weekly != null) {
    segs.push({ label: "Weekly (7d)", short: "7d", limit: data.limits.weekly });
  }
  if (data.limits.monthly != null) {
    segs.push({ label: "Monthly (30d)", short: "30d", limit: data.limits.monthly });
  }
  return segs;
}

/** Format usage for the /ollama-cloud-usage command output. */
export function formatUsage(data: UsageData): string {
  const lines: string[] = ["Ollama Cloud usage:"];

  for (const seg of limitSegments(data)) {
    lines.push(`  ${seg.label}: ${usagePercent(seg.limit.usage)}%`);
    for (const m of seg.limit.models) {
      lines.push(`    - ${m.name}: ${m.request_count} request${m.request_count === 1 ? "" : "s"}`);
    }
  }

  if (typeof data.activity?.cost === "string") {
    lines.push(`  Activity (4wk): $${data.activity.cost}`);
  }

  return lines.join("\n");
}

/** Render a 10-character quota bar for a 0-100 percentage. */
function quotaBar(pct: number): string {
  const filled = Math.min(Math.max(Math.floor(pct / 10), 0), 10);
  return `▕${"█".repeat(filled)}${"░".repeat(10 - filled)}▏`;
}

/** Color a single usage segment by how close it is to the cap. */
function colorSegment(theme: Theme, label: string, pct: number): string {
  const color = pct >= 80 ? "error" : pct >= 60 ? "warning" : "success";
  return theme.fg(color, `${label} ${quotaBar(pct)} ${pct}%`);
}

/**
 * Compact one-line usage for the footer status bar, colored by usage level,
 * with one segment per limit bucket present in the response (5h and 7d, or
 * 30d when the API serves the monthly shape). The color reflects the usage
 * fraction rather than pace because the bucket periods differ per shape.
 */
export function formatUsageStatusColored(theme: Theme, data: UsageData): string {
  return limitSegments(data)
    .map((seg) => colorSegment(theme, seg.short, usagePercent(seg.limit.usage)))
    .join(" ");
}
