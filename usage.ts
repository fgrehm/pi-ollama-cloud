import type { Theme } from "@earendil-works/pi-coding-agent";
import { OLLAMA_BASE } from "./models.ts";
import { fetchJsonWithTimeout, httpError } from "./utils.ts";

export interface BalanceWindow {
  remaining_percent: number;
  resets_at?: string;
}

export interface UsageData {
  included?: {
    session?: BalanceWindow;
    weekly?: BalanceWindow;
    monthly?: BalanceWindow;
    balance_usd?: number;
    allowance_usd?: number;
    period?: { from?: string; until?: string };
  };
  purchased?: { balance_usd?: number };
}

export interface UsageBucket {
  from?: string;
  until?: string;
  request_count: number;
  partial?: boolean;
  usage_usd?: number;
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

export interface UsageStats {
  range?: "24h" | "7d" | "30d";
  totals: {
    request_count: number;
    usage_usd?: number;
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  buckets?: UsageBucket[];
}

const USAGE_TIMEOUT_MS = 10000;

function isObject(data: unknown): data is Record<string, unknown> {
  return data !== null && typeof data === "object" && !Array.isArray(data);
}

export function isBalanceWindow(data: unknown): data is BalanceWindow {
  if (!isObject(data) || typeof data.remaining_percent !== "number" || !Number.isFinite(data.remaining_percent)) {
    return false;
  }
  return data.resets_at === undefined || typeof data.resets_at === "string";
}

function isPurchased(data: unknown): boolean {
  return isObject(data) && typeof data.balance_usd === "number" && Number.isFinite(data.balance_usd);
}

function isIncluded(data: unknown): data is NonNullable<UsageData["included"]> {
  if (!isObject(data)) return false;
  const windows = [data.session, data.weekly, data.monthly];
  if (windows.some((window) => window !== undefined && !isBalanceWindow(window))) return false;

  const balance = data.balance_usd;
  const allowance = data.allowance_usd;
  if (balance !== undefined && (typeof balance !== "number" || !Number.isFinite(balance))) return false;
  if (allowance !== undefined && (typeof allowance !== "number" || !Number.isFinite(allowance))) return false;
  if ((balance === undefined) !== (allowance === undefined)) return false;

  if (data.period !== undefined) {
    if (!isObject(data.period)) return false;
    if (data.period.from !== undefined && typeof data.period.from !== "string") return false;
    if (data.period.until !== undefined && typeof data.period.until !== "string") return false;
  }

  return true;
}

export function isUsageResponse(data: unknown): data is UsageData {
  if (!isObject(data)) return false;
  const included = data.included;
  const hasPurchased = isPurchased(data.purchased);
  if (data.purchased !== undefined && !hasPurchased) return false;
  if (included === undefined) return hasPurchased;
  if (!isIncluded(included)) return false;

  const hasWindow = [included.session, included.weekly, included.monthly].some(isBalanceWindow);
  const hasAllowance = typeof included.balance_usd === "number" && typeof included.allowance_usd === "number";
  return hasWindow || hasAllowance || hasPurchased;
}

export function isUsageStats(data: unknown): data is UsageStats {
  if (!isObject(data) || !isObject(data.totals) || typeof data.totals.request_count !== "number") return false;
  if (data.buckets === undefined) return true;
  return (
    Array.isArray(data.buckets) &&
    data.buckets.every((bucket) => isObject(bucket) && typeof bucket.request_count === "number")
  );
}

export async function fetchUsage(apiKey: string, externalSignal?: AbortSignal): Promise<UsageData> {
  const res = await fetchJsonWithTimeout<UsageData>(
    `${OLLAMA_BASE}/api/balance`,
    { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
    USAGE_TIMEOUT_MS,
    externalSignal,
  );
  if (!res.ok) {
    if (res.status === 0) {
      throw new Error(`Ollama Cloud balance failed: transport error (${res.error ?? "unknown"}). Try again shortly.`);
    }
    if (res.status === 404) {
      throw new Error("Ollama Cloud balance failed: the /api/balance endpoint is unavailable (status 404).");
    }
    httpError("balance", res.status, res.error);
  }
  if (!isUsageResponse(res.data))
    throw new Error("Ollama Cloud balance failed: unexpected response shape from the API.");
  return res.data;
}

export async function fetchUsageStats(
  apiKey: string,
  range: "24h" | "7d" | "30d" = "7d",
  externalSignal?: AbortSignal,
): Promise<UsageStats> {
  const res = await fetchJsonWithTimeout<UsageStats>(
    `${OLLAMA_BASE}/api/usage?range=${range}`,
    { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
    USAGE_TIMEOUT_MS,
    externalSignal,
  );
  if (!res.ok) httpError("usage stats", res.status, res.error);
  if (!isUsageStats(res.data))
    throw new Error("Ollama Cloud usage stats failed: unexpected response shape from the API.");
  return res.data;
}

function usedPercent(remaining: number): number {
  if (!Number.isFinite(remaining)) return 100;
  return Math.min(Math.max(Math.round(100 - remaining), 0), 100);
}

function limitSegments(data: UsageData): Array<{ short: string; used: number }> {
  const included = data.included;
  if (!included) return [];
  const segments: Array<{ short: string; used: number }> = [];
  for (const [key, short] of [
    ["session", "5h"],
    ["weekly", "7d"],
    ["monthly", "30d"],
  ] as const) {
    const window = included[key];
    if (window && isBalanceWindow(window)) segments.push({ short, used: usedPercent(window.remaining_percent) });
  }
  if (
    segments.length === 0 &&
    typeof included.balance_usd === "number" &&
    typeof included.allowance_usd === "number" &&
    included.allowance_usd > 0
  ) {
    const used = (1 - included.balance_usd / included.allowance_usd) * 100;
    segments.push({ short: "plan", used: Math.min(Math.max(Math.round(used), 0), 100) });
  }
  return segments;
}

export function formatUsage(data: UsageData, stats?: UsageStats): string {
  const lines = ["Ollama Cloud usage:"];
  for (const segment of limitSegments(data)) lines.push(`  ${segment.short}: ${segment.used}% used`);
  const included = data.included;
  if (included && typeof included.balance_usd === "number" && typeof included.allowance_usd === "number") {
    lines.push(
      `  Included balance: $${included.balance_usd.toFixed(2)} / $${included.allowance_usd.toFixed(2)} remaining`,
    );
    if (included.period?.from || included.period?.until) {
      lines.push(`  Included allowance period: ${included.period.from ?? "?"} to ${included.period.until ?? "?"}`);
      if (included.period.until) lines.push(`  Included allowance renews: ${included.period.until}`);
    }
  }
  if (data.purchased?.balance_usd && data.purchased.balance_usd > 0) {
    lines.push(`  Purchased credits: $${data.purchased.balance_usd.toFixed(2)}`);
  }
  if (stats) {
    lines.push(`  Requests (${stats.range ?? "7d"}): ${stats.totals.request_count.toLocaleString()}`);
    const current = stats.buckets?.at(-1);
    if (current?.partial) lines.push(`    - current period: ${current.request_count.toLocaleString()}`);
  }
  return lines.join("\n");
}

function quotaBar(pct: number): string {
  const filled = Math.min(Math.max(Math.floor(pct / 10), 0), 10);
  return `▕${"█".repeat(filled)}${"░".repeat(10 - filled)}▏`;
}

function colorSegment(theme: Theme, label: string, pct: number): string {
  const color = pct >= 80 ? "error" : pct >= 60 ? "warning" : "success";
  return theme.fg(color, `${label} ${quotaBar(pct)} ${pct}%`);
}

export function formatUsageStatusColored(theme: Theme, data: UsageData): string {
  return limitSegments(data)
    .map((segment) => colorSegment(theme, segment.short, segment.used))
    .join(" ");
}
