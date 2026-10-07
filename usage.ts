/**
 * Ollama Cloud usage data plane: fetch and format /api/balance (quota) and
 * /api/usage (request histogram).
 *
 * Self-contained module. Depends on:
 *   - models.ts - only for OLLAMA_BASE URL constant
 *   - utils.ts  - fetchJsonWithTimeout
 * Does NOT depend on provider registration, model fetching, or API key
 * resolution (the caller resolves the key and passes it in).
 *
 * The endpoints are undocumented and have changed shape repeatedly:
 *   - Through 2026-09-02, /api/usage carried limits.session and limits.weekly.
 *   - On 2026-09-03 it served a single limits.monthly bucket (0.10.0).
 *   - By 2026-09-07 it served session and weekly again (0.11.0).
 *   - On 2026-10-06 Ollama redeployed and split the data in two: quota moved
 *     to GET /api/balance (included.{session,weekly[,monthly]} windows with
 *     remaining_percent 0-100 and resets_at, plus purchased.balance_usd), and
 *     /api/usage became a windowed request histogram (?range=24h|7d|30d, with
 *     hourly/daily buckets and totals.request_count) with no per-model counts
 *     and no caps. Quota bars read balance; the histogram is informational.
 *
 * Whichever balance windows are present are displayed; each is validated
 * independently, so partial shapes keep working.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { OLLAMA_BASE } from "./models.ts";
import { fetchJsonWithTimeout, httpError } from "./utils.ts";

// --- Types ---

export interface BalanceWindow {
  /** Remaining quota as a 0-100 percentage (not a used fraction). */
  remaining_percent: number;
  /** When the window resets, ISO 8601. Optional. */
  resets_at?: string;
}

export interface BalanceData {
  /** Plan-included quota windows. May be absent when only credits exist. */
  included?: {
    /** Session (5h-ish) quota window. */
    session?: BalanceWindow;
    /** Weekly (7d) quota window. */
    weekly?: BalanceWindow;
    /** Monthly (30d) quota window, when the account has one. */
    monthly?: BalanceWindow;
  };
  /** Purchased credit top-ups. Optional. */
  purchased?: { balance_usd?: number };
}

export interface UsageBucket {
  from?: string;
  until?: string;
  request_count: number;
  partial?: boolean;
}

export interface UsageStats {
  range?: string;
  granularity?: string;
  totals: { request_count: number };
  buckets?: UsageBucket[];
}

/** Accepted histogram window lengths for /api/usage?range=. */
export type UsageRange = "24h" | "7d" | "30d";

// --- Constants ---

const USAGE_TIMEOUT_MS = 10000;

// --- Validation ---

/** Validate a single balance window: 0-100 remaining percentage plus optional reset time. */
export function isBalanceWindow(data: unknown): data is BalanceWindow {
  if (data == null || typeof data !== "object") return false;
  const d = data as BalanceWindow;
  if (typeof d.remaining_percent !== "number") return false;
  return d.resets_at === undefined || typeof d.resets_at === "string";
}

/** Purchased-credit container: optional object with optional numeric balance_usd. */
function isPurchased(data: unknown): boolean {
  if (data === undefined) return false;
  if (data == null || typeof data !== "object" || Array.isArray(data)) return false;
  const value = (data as { balance_usd?: unknown }).balance_usd;
  return value === undefined || typeof value === "number";
}

/**
 * Validate a parsed /api/balance response: needs at least one valid quota
 * window or a purchased-credit object, with any present windows valid. The
 * response shape flips between session+weekly and monthly-only per account,
 * so any window subset is accepted.
 */
export function isBalanceResponse(data: unknown): data is BalanceData {
  if (data == null || typeof data !== "object" || Array.isArray(data)) return false;
  const d = data as Partial<BalanceData>;
  const included = d.included;
  const windows =
    included == null || typeof included !== "object" || Array.isArray(included)
      ? []
      : [included.session, included.weekly, included.monthly];
  if (included == null && !isPurchased(d.purchased)) return false;
  const hasWindow = windows.some(isBalanceWindow);
  if (!hasWindow && !isPurchased(d.purchased)) return false;
  return windows.every((w) => w === undefined || isBalanceWindow(w));
}

/**
 * Validate a parsed /api/usage histogram response: needs totals.request_count;
 * buckets are optional and validated when present.
 */
export function isUsageStats(data: unknown): data is UsageStats {
  if (data == null || typeof data !== "object" || Array.isArray(data)) return false;
  const d = data as Partial<UsageStats>;
  if (d.totals == null || typeof d.totals !== "object" || typeof d.totals.request_count !== "number") return false;
  if (d.buckets === undefined) return true;
  return (
    Array.isArray(d.buckets) &&
    d.buckets.every((b) => b != null && typeof b === "object" && typeof (b as UsageBucket).request_count === "number")
  );
}

// --- Fetch ---

/**
 * Throw a formatted error for a non-ok response. The 404 case maps to a
 * distinct message because these endpoints are undocumented and may change.
 */
function fetchFailure(op: string, status: number, error: string | undefined, endpoint: string): never {
  if (status === 0) {
    throw new Error(`Ollama Cloud ${op} failed: transport error (${error ?? "unknown"}). Try again shortly.`);
  }
  if (status === 404) {
    throw new Error(
      `Ollama Cloud ${op} failed: the ${endpoint} endpoint is unavailable (status 404). ` +
        "It is undocumented and may have changed.",
    );
  }
  httpError(op, status, error);
}

/**
 * Fetch Ollama Cloud quota from the undocumented /api/balance endpoint.
 * The caller resolves the API key and passes it in.
 */
export async function fetchBalance(apiKey: string, externalSignal?: AbortSignal): Promise<BalanceData> {
  const res = await fetchJsonWithTimeout<BalanceData>(
    `${OLLAMA_BASE}/api/balance`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    USAGE_TIMEOUT_MS,
    externalSignal,
  );

  if (!res.ok) {
    fetchFailure("balance", res.status, res.error, "/api/balance");
  }
  if (!isBalanceResponse(res.data)) {
    throw new Error("Ollama Cloud balance failed: unexpected response shape from the API.");
  }
  return res.data;
}

/**
 * Fetch a request-count histogram from the undocumented /api/usage endpoint.
 * The endpoint is rate-limited (429 with retry-after ~1s), so callers must
 * space successive requests. The caller resolves the API key and passes it in.
 */
export async function fetchUsageStats(
  apiKey: string,
  range: UsageRange = "7d",
  externalSignal?: AbortSignal,
): Promise<UsageStats> {
  const res = await fetchJsonWithTimeout<UsageStats>(
    `${OLLAMA_BASE}/api/usage?range=${range}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    USAGE_TIMEOUT_MS,
    externalSignal,
  );

  if (!res.ok) {
    fetchFailure("usage stats", res.status, res.error, "/api/usage");
  }
  if (!isUsageStats(res.data)) {
    throw new Error("Ollama Cloud usage stats failed: unexpected response shape from the API.");
  }
  return res.data;
}

// --- Formatting ---

/** Used percentage (0-100, rounded) from a 0-100 remaining_percent value. */
function usedPercent(remainingPercent: number): number {
  if (!Number.isFinite(remainingPercent)) return 100;
  return Math.min(Math.max(Math.round(100 - remainingPercent), 0), 100);
}

/** The balance windows present in a response, in display order. */
function balanceSegments(
  data: BalanceData,
): Array<{ label: string; short: string; window: BalanceWindow; used: number }> {
  const defs: Array<["session" | "weekly" | "monthly", string, string]> = [
    ["session", "Session (5h)", "5h"],
    ["weekly", "Weekly (7d)", "7d"],
    ["monthly", "Monthly (30d)", "30d"],
  ];
  const segs: Array<{ label: string; short: string; window: BalanceWindow; used: number }> = [];
  for (const [key, label, short] of defs) {
    const window = data.included?.[key];
    if (window && isBalanceWindow(window)) {
      segs.push({ label, short, window, used: usedPercent(window.remaining_percent) });
    }
  }
  return segs;
}

/** Human reset time: a clock time when the reset is today, else a short date-time. */
export function formatReset(iso: string | undefined): string {
  if (!iso) return "";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  const now = new Date();
  const sameDay =
    when.getFullYear() === now.getFullYear() && when.getMonth() === now.getMonth() && when.getDate() === now.getDate();
  return sameDay
    ? when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : when.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Format usage for the /ollama-cloud-usage command output. */
export function formatBalance(data: BalanceData, stats?: UsageStats): string {
  const lines: string[] = ["Ollama Cloud usage:"];

  for (const seg of balanceSegments(data)) {
    const reset = formatReset(seg.window.resets_at);
    lines.push(`  ${seg.label}: ${seg.used}% used${reset ? ` — resets ${reset}` : ""}`);
  }

  const credits = data.purchased?.balance_usd;
  if (typeof credits === "number" && credits > 0) {
    lines.push(`  Purchased credits: $${credits.toFixed(2)}`);
  }

  if (stats) {
    lines.push(`  Requests (${stats.range ?? "7d"}): ${stats.totals.request_count.toLocaleString()}`);
    const last = stats.buckets?.at(-1);
    if (last?.partial) {
      lines.push(`    - current period: ${last.request_count.toLocaleString()}`);
    }
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
 * with one segment per quota window present in the balance response (5h and
 * 7d, or 30d when the account serves the monthly shape). Returns "" when no
 * windows are present so the caller can clear the status.
 */
export function formatBalanceStatusColored(theme: Theme, data: BalanceData): string {
  return balanceSegments(data)
    .map((seg) => colorSegment(theme, seg.short, seg.used))
    .join(" ");
}
