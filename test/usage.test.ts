import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchUsage,
  fetchUsageStats,
  formatUsage,
  formatUsageStatusColored,
  isBalanceWindow,
  isUsageResponse,
  isUsageStats,
} from "../usage.ts";

// --- Helpers ---

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A minimal valid /api/balance response using the included allowance shape. */
function usageResponse(overrides: { monthlyUsage?: number } = {}) {
  return {
    included: {
      monthly: { remaining_percent: 100 - (overrides.monthlyUsage ?? 0.34) * 100 },
      balance_usd: 66.74607,
      allowance_usd: 300,
      period: { from: "2026-09-12T09:32:38Z", until: "2026-10-12T09:32:38Z" },
    },
    purchased: { balance_usd: 0 },
  };
}

/** A legacy /api/balance response with session and weekly windows. */
function sessionWeeklyResponse(overrides: { sessionUsage?: number; weeklyUsage?: number } = {}) {
  return {
    included: {
      session: { remaining_percent: 100 - (overrides.sessionUsage ?? 0.4) * 100 },
      weekly: { remaining_percent: 100 - (overrides.weeklyUsage ?? 0.07) * 100 },
    },
    purchased: { balance_usd: 0 },
  };
}

/** Mock globalThis.fetch to return the given status and body. */
function mockFetch(status: number, body: unknown) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ============================================================================
// isUsageLimit
// ============================================================================

describe("isBalanceWindow", () => {
  it("accepts a balance window with remaining_percent", () => {
    expect(isBalanceWindow({ remaining_percent: 50 })).toBe(true);
  });

  it("accepts a balance window with resets_at", () => {
    expect(isBalanceWindow({ remaining_percent: 50, resets_at: "2026-10-07T08:00:00Z" })).toBe(true);
  });

  it("rejects a non-number remaining_percent", () => {
    expect(isBalanceWindow({ remaining_percent: "50" })).toBe(false);
  });

  it("rejects null input", () => {
    expect(isBalanceWindow(null)).toBe(false);
  });

  it("rejects a non-string resets_at", () => {
    expect(isBalanceWindow({ remaining_percent: 50, resets_at: 7 })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isBalanceWindow("string")).toBe(false);
  });
});

// ============================================================================
// isUsageResponse
// ============================================================================

describe("isUsageResponse", () => {
  it("accepts legacy windows and the allowance balance shape", () => {
    expect(isUsageResponse(usageResponse())).toBe(true);
    expect(
      isUsageResponse({ included: { balance_usd: 66.7, allowance_usd: 300, period: { from: "x", until: "y" } } }),
    ).toBe(true);
  });

  it("accepts a session plus weekly response", () => {
    expect(isUsageResponse(sessionWeeklyResponse())).toBe(true);
  });

  it("rejects a response without quota data", () => {
    expect(isUsageResponse({})).toBe(false);
  });

  it("accepts a purchased-only response with a numeric balance", () => {
    expect(isUsageResponse({ purchased: { balance_usd: 1.25 } })).toBe(true);
  });

  it("rejects a purchased object without a balance", () => {
    expect(isUsageResponse({ included: {}, purchased: {} })).toBe(false);
    expect(isUsageResponse({ purchased: {} })).toBe(false);
  });

  it("accepts a session-only response", () => {
    expect(isUsageResponse({ included: { session: { remaining_percent: 60 } } })).toBe(true);
  });

  it("rejects a malformed optional window", () => {
    expect(
      isUsageResponse({ included: { session: { remaining_percent: 80 }, monthly: { remaining_percent: "bad" } } }),
    ).toBe(false);
  });

  it("rejects a response with no valid quota data", () => {
    expect(isUsageResponse({ included: {} })).toBe(false);
  });

  it("rejects malformed allowance fields even when purchased balance is valid", () => {
    expect(
      isUsageResponse({ included: { balance_usd: "55.5", allowance_usd: 60 }, purchased: { balance_usd: 0 } }),
    ).toBe(false);
    expect(isUsageResponse({ included: { balance_usd: 55.5 }, purchased: { balance_usd: 0 } })).toBe(false);
  });

  it("rejects malformed billing-period fields", () => {
    expect(isUsageResponse({ included: { balance_usd: 55.5, allowance_usd: 60, period: { until: {} } } })).toBe(false);
    expect(
      isUsageResponse({
        included: {
          balance_usd: 55.5,
          allowance_usd: 60,
          period: { until: { toString: null, valueOf: null } },
        },
      }),
    ).toBe(false);
    expect(isUsageResponse({ included: { balance_usd: 55.5, allowance_usd: 60, period: null } })).toBe(false);
  });

  it("rejects malformed purchased data", () => {
    expect(isUsageResponse({ purchased: { balance_usd: "1.25" } })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isUsageResponse(null)).toBe(false);
    expect(isUsageResponse("string")).toBe(false);
  });
});

// ============================================================================
// fetchUsage
// ============================================================================

describe("fetchUsage", () => {
  it("returns parsed usage on a 200 response", async () => {
    mockFetch(200, usageResponse());
    const data = await fetchUsage("key");
    expect(data.included?.monthly?.remaining_percent).toBe(66);
  });

  it("returns parsed session and weekly usage on a 200 response", async () => {
    mockFetch(200, sessionWeeklyResponse());
    const data = await fetchUsage("key");
    expect(data.included?.session?.remaining_percent).toBe(60);
    expect(data.included?.weekly?.remaining_percent).toBe(93);
  });

  it("requests the balance endpoint", async () => {
    let url = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      url = String(input);
      return new Response(JSON.stringify(usageResponse()), { status: 200 });
    }) as typeof fetch;
    await fetchUsage("key");
    expect(url).toBe("https://ollama.com/api/balance");
  });

  it("throws an auth error on 401", async () => {
    mockFetch(401, { error: "unauthorized" });
    await expect(fetchUsage("key")).rejects.toThrow(/authentication error/);
  });

  it("throws an auth error on 403", async () => {
    mockFetch(403, { error: "forbidden" });
    await expect(fetchUsage("key")).rejects.toThrow(/authentication error/);
  });

  it("throws a rate-limit error on 429", async () => {
    mockFetch(429, { error: "rate limited" });
    await expect(fetchUsage("key")).rejects.toThrow(/rate limited/);
  });

  it("throws an endpoint-unavailable error on 404", async () => {
    mockFetch(404, { error: "not found" });
    await expect(fetchUsage("key")).rejects.toThrow(/unavailable/);
  });

  it("throws a server error on 500", async () => {
    mockFetch(500, { error: "boom" });
    await expect(fetchUsage("key")).rejects.toThrow(/server error/);
  });

  it("throws on a malformed response shape", async () => {
    mockFetch(200, { included: { session: { remaining_percent: "x" } } });
    await expect(fetchUsage("key")).rejects.toThrow(/unexpected response shape/);
  });

  it("reports status-zero transport errors explicitly", async () => {
    globalThis.fetch = async () => {
      throw new Error("network unavailable");
    };
    await expect(fetchUsage("key")).rejects.toThrow(/transport error/);
  });
});

describe("fetchUsageStats", () => {
  it("accepts modern token and cost totals while tolerating omitted optional fields", () => {
    expect(
      isUsageStats({
        totals: { request_count: 1, usage_usd: 0.1, input_tokens: 2, cached_input_tokens: 1, output_tokens: 3 },
      }),
    ).toBe(true);
    expect(isUsageStats({ totals: { request_count: 1 } })).toBe(true);
  });

  it("fetches and validates a documented histogram", async () => {
    let url = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      url = String(input);
      return new Response(
        JSON.stringify({ range: "7d", totals: { request_count: 12 }, buckets: [{ request_count: 2, partial: true }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    const stats = await fetchUsageStats("key", "7d");
    expect(url).toContain("/api/usage?range=7d");
    expect(isUsageStats(stats)).toBe(true);
  });

  it("rejects a malformed histogram", async () => {
    mockFetch(200, { totals: {} });
    await expect(fetchUsageStats("key")).rejects.toThrow(/unexpected response shape/);
  });
});

// ============================================================================
// formatUsage
// ============================================================================

describe("formatUsage", () => {
  it("formats the monthly percentage and included balance", () => {
    const out = formatUsage(usageResponse());
    expect(out).toContain("30d: 34% used");
    expect(out).toContain("Included balance: $66.75 / $300.00 remaining");
  });

  it("formats session and weekly percentages", () => {
    const out = formatUsage(sessionWeeklyResponse());
    expect(out).toContain("5h: 40% used");
    expect(out).toContain("7d: 7% used");
  });

  it("formats the allowance renewal date from the included balance", () => {
    expect(formatUsage(usageResponse())).toContain("Included allowance renews: 2026-10-12T09:32:38Z");
  });

  it("formats included balance", () => {
    const out = formatUsage(usageResponse());
    expect(out).toContain("Included balance:");
  });

  it("ignores malformed optional buckets when another bucket is valid", () => {
    const data = sessionWeeklyResponse();
    (data.included as Record<string, unknown>).monthly = { remaining_percent: "bad" };
    const out = formatUsage(data);
    expect(out).toContain("5h: 40% used");
    expect(out).not.toContain("30d");
  });
});

// ============================================================================
// formatUsageStatusColored
// ============================================================================

/** A minimal Theme stub that wraps text in a color tag for assertions. */
const fakeTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as unknown as Theme;

describe("formatUsageStatusColored", () => {
  it("formats a compact one-line status with a quota bar", () => {
    expect(formatUsageStatusColored(fakeTheme, usageResponse())).toBe("<success>30d ▕███░░░░░░░▏ 34%</success>");
  });

  it("renders one segment per bucket for a session plus weekly response", () => {
    expect(formatUsageStatusColored(fakeTheme, sessionWeeklyResponse())).toBe(
      "<success>5h ▕████░░░░░░▏ 40%</success> <success>7d ▕░░░░░░░░░░▏ 7%</success>",
    );
  });

  it("colors a segment red at 80% or above", () => {
    expect(formatUsageStatusColored(fakeTheme, usageResponse({ monthlyUsage: 0.85 }))).toContain(
      "<error>30d ▕████████░░▏ 85%</error>",
    );
  });

  it("colors a segment yellow at 60-79%", () => {
    expect(formatUsageStatusColored(fakeTheme, usageResponse({ monthlyUsage: 0.7 }))).toContain(
      "<warning>30d ▕███████░░░▏ 70%</warning>",
    );
  });

  it("clamps the bar at 0% and 100%", () => {
    expect(formatUsageStatusColored(fakeTheme, usageResponse({ monthlyUsage: 0 }))).toBe(
      "<success>30d ▕░░░░░░░░░░▏ 0%</success>",
    );
  });

  it("clamps usage above 1 and NaN to 100% and 0%", () => {
    expect(formatUsageStatusColored(fakeTheme, usageResponse({ monthlyUsage: 1.05 }))).toBe(
      "<error>30d ▕██████████▏ 100%</error>",
    );
  });
});
