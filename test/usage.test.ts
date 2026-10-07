import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchBalance,
  fetchUsageStats,
  formatBalance,
  formatBalanceStatusColored,
  isBalanceResponse,
  isBalanceWindow,
  isUsageStats,
  type UsageBucket,
} from "../usage.ts";

// --- Helpers ---

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A minimal valid /api/balance response with session and weekly windows. */
function balanceResponse(
  overrides: {
    sessionRemaining?: number;
    weeklyRemaining?: number;
    monthlyRemaining?: number;
    resetsAt?: string;
    purchasedUsd?: number;
  } = {},
) {
  const included: Record<string, unknown> = {};
  if (overrides.sessionRemaining !== undefined) {
    included.session = { remaining_percent: overrides.sessionRemaining, resets_at: overrides.resetsAt };
  }
  if (overrides.weeklyRemaining !== undefined) {
    included.weekly = { remaining_percent: overrides.weeklyRemaining, resets_at: overrides.resetsAt };
  }
  if (overrides.monthlyRemaining !== undefined) {
    included.monthly = { remaining_percent: overrides.monthlyRemaining };
  }
  return {
    included,
    purchased: { balance_usd: overrides.purchasedUsd ?? 0 },
  };
}

/** A histogram response as served since 2026-10-06. */
function statsResponse(overrides: { range?: string; total?: number; buckets?: UsageBucket[] } = {}) {
  return {
    range: overrides.range ?? "7d",
    scope: "self",
    granularity: "day",
    totals: { request_count: overrides.total ?? 4497 },
    buckets: overrides.buckets ?? [
      { from: "2026-09-30T00:00:00Z", until: "2026-10-01T00:00:00Z", request_count: 484 },
      { from: "2026-10-07T00:00:00Z", until: "2026-10-07T03:37:21Z", partial: true, request_count: 277 },
    ],
  };
}

/** Mock globalThis.fetch to return the given status and body. */
function mockFetch(status: number, body: unknown) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ============================================================================
// isBalanceWindow
// ============================================================================

describe("isBalanceWindow", () => {
  it("accepts a valid window", () => {
    expect(isBalanceWindow({ remaining_percent: 89.7, resets_at: "2026-10-07T08:00:00Z" })).toBe(true);
  });

  it("accepts a window without a reset time", () => {
    expect(isBalanceWindow({ remaining_percent: 89.7 })).toBe(true);
  });

  it("rejects a non-number remaining_percent", () => {
    expect(isBalanceWindow({ remaining_percent: "89.7" })).toBe(false);
    expect(isBalanceWindow({ resets_at: "2026-10-07T08:00:00Z" })).toBe(false);
  });

  it("rejects a non-string resets_at", () => {
    expect(isBalanceWindow({ remaining_percent: 50, resets_at: 7 })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isBalanceWindow(null)).toBe(false);
    expect(isBalanceWindow("string")).toBe(false);
  });
});

// ============================================================================
// isBalanceResponse
// ============================================================================

describe("isBalanceResponse", () => {
  it("accepts a session plus weekly response", () => {
    expect(isBalanceResponse(balanceResponse({ sessionRemaining: 89.7, weeklyRemaining: 69.86 }))).toBe(true);
  });

  it("accepts a response with a missing window", () => {
    expect(isBalanceResponse(balanceResponse({ weeklyRemaining: 69.86 }))).toBe(true);
  });

  it("accepts a windows-only response without included when purchased is valid", () => {
    expect(isBalanceResponse({ included: null, purchased: { balance_usd: 1.25 } })).toBe(true);
  });

  it("accepts a purchased-only response", () => {
    expect(isBalanceResponse({ purchased: { balance_usd: 12.5 } })).toBe(true);
  });

  it("rejects a response with no windows and no purchased object", () => {
    expect(isBalanceResponse({})).toBe(false);
    expect(isBalanceResponse({ included: {} })).toBe(false);
  });

  it("rejects a response where all windows are invalid", () => {
    const data = balanceResponse({ sessionRemaining: 89.7, weeklyRemaining: 69.86 });
    (data.included.session as { remaining_percent?: unknown }).remaining_percent = "89.7";
    (data.included.weekly as { remaining_percent?: unknown }).remaining_percent = "69.86";
    expect(isBalanceResponse(data)).toBe(false);
  });

  it("rejects a response with a malformed window among valid ones", () => {
    const data = balanceResponse({ sessionRemaining: 89.7, weeklyRemaining: 69.86 });
    (data.included.session as { resets_at?: unknown }).resets_at = 7;
    expect(isBalanceResponse(data)).toBe(false);
  });

  it("rejects a non-object purchased", () => {
    expect(isBalanceResponse({ purchased: "0.00" })).toBe(false);
    expect(isBalanceResponse({ purchased: { balance_usd: "12.50" } })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isBalanceResponse(null)).toBe(false);
    expect(isBalanceResponse("string")).toBe(false);
  });
});

// ============================================================================
// isUsageStats
// ============================================================================

describe("isUsageStats", () => {
  it("accepts a histogram with buckets", () => {
    expect(isUsageStats(statsResponse())).toBe(true);
  });

  it("accepts totals without buckets", () => {
    expect(isUsageStats({ range: "7d", totals: { request_count: 10 } })).toBe(true);
  });

  it("rejects a response missing totals.request_count", () => {
    expect(isUsageStats({ range: "7d" })).toBe(false);
    expect(isUsageStats({ totals: {} })).toBe(false);
  });

  it("rejects a response with a bucket missing request_count", () => {
    const bad = [{ from: "2026-10-01T00:00:00Z" }] as unknown as UsageBucket[];
    expect(isUsageStats(statsResponse({ buckets: bad }))).toBe(false);
  });

  it("rejects a non-array buckets field", () => {
    expect(isUsageStats(statsResponse({ buckets: {} as unknown as UsageBucket[] }))).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isUsageStats(null)).toBe(false);
    expect(isUsageStats("string")).toBe(false);
  });
});

// ============================================================================
// fetchBalance
// ============================================================================

describe("fetchBalance", () => {
  it("returns parsed windows on a 200 response", async () => {
    mockFetch(200, balanceResponse({ sessionRemaining: 89.7, weeklyRemaining: 69.86 }));
    const data = await fetchBalance("key");
    expect(data.included?.session?.remaining_percent).toBe(89.7);
    expect(data.included?.weekly?.remaining_percent).toBe(69.86);
  });

  it("hits the /api/balance endpoint", async () => {
    let url = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      url = String(input);
      return new Response(JSON.stringify(balanceResponse({ sessionRemaining: 50 })), { status: 200 });
    }) as typeof fetch;
    await fetchBalance("key");
    expect(url).toBe("https://ollama.com/api/balance");
  });

  it("throws an auth error on 401", async () => {
    mockFetch(401, { error: "unauthorized" });
    await expect(fetchBalance("key")).rejects.toThrow(/authentication error/);
  });

  it("throws an auth error on 403", async () => {
    mockFetch(403, { error: "forbidden" });
    await expect(fetchBalance("key")).rejects.toThrow(/authentication error/);
  });

  it("throws a rate-limit error on 429", async () => {
    mockFetch(429, { error: "too many requests" });
    await expect(fetchBalance("key")).rejects.toThrow(/rate limited/);
  });

  it("throws an endpoint-unavailable error on 404", async () => {
    mockFetch(404, { error: "not found" });
    await expect(fetchBalance("key")).rejects.toThrow(/\/api\/balance endpoint is unavailable/);
  });

  it("throws a server error on 500", async () => {
    mockFetch(500, { error: "boom" });
    await expect(fetchBalance("key")).rejects.toThrow(/server error/);
  });

  it("throws on a malformed response shape", async () => {
    mockFetch(200, { included: { session: { remaining_percent: "89.7" } } });
    await expect(fetchBalance("key")).rejects.toThrow(/unexpected response shape/);
  });

  it("reports status-zero transport errors explicitly", async () => {
    globalThis.fetch = async () => {
      throw new Error("network unavailable");
    };
    await expect(fetchBalance("key")).rejects.toThrow(/transport error/);
  });
});

// ============================================================================
// fetchUsageStats
// ============================================================================

describe("fetchUsageStats", () => {
  it("returns parsed totals on a 200 response", async () => {
    mockFetch(200, statsResponse());
    const data = await fetchUsageStats("key");
    expect(data.totals.request_count).toBe(4497);
    expect(data.buckets?.at(-1)?.partial).toBe(true);
  });

  it("requests the given range and defaults to 7d", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify(statsResponse()), { status: 200 });
    }) as typeof fetch;
    await fetchUsageStats("key", "24h");
    await fetchUsageStats("key");
    expect(urls).toEqual(["https://ollama.com/api/usage?range=24h", "https://ollama.com/api/usage?range=7d"]);
  });

  it("throws a rate-limit error on 429", async () => {
    mockFetch(429, { error: "too many requests" });
    await expect(fetchUsageStats("key")).rejects.toThrow(/rate limited/);
  });

  it("throws a generic error on 400 parameter rejections", async () => {
    mockFetch(400, { error: "range must be 24h, 7d, or 30d" });
    await expect(fetchUsageStats("key")).rejects.toThrow(/unexpected response \(status 400/);
  });

  it("throws on a malformed response shape", async () => {
    mockFetch(200, { range: "7d", totals: {} });
    await expect(fetchUsageStats("key")).rejects.toThrow(/unexpected response shape/);
  });
});

// ============================================================================
// formatBalance
// ============================================================================

describe("formatBalance", () => {
  it("formats used percentages and reset times", () => {
    const out = formatBalance(
      balanceResponse({ sessionRemaining: 89.7, weeklyRemaining: 69.86, resetsAt: "2026-10-12T00:00:00Z" }),
    );
    expect(out).toContain("Session (5h): 10% used — resets ");
    expect(out).toContain("Weekly (7d): 30% used — resets ");
  });

  it("formats a monthly-only response", () => {
    const out = formatBalance(balanceResponse({ monthlyRemaining: 40 }));
    expect(out).toContain("Monthly (30d): 60% used");
  });

  it("omits the reset suffix when resets_at is absent", () => {
    const out = formatBalance(balanceResponse({ monthlyRemaining: 40 }));
    expect(out).toMatch(/^ {2}Monthly \(30d\): 60% used$/m);
    expect(out).not.toContain("resets");
  });

  it("includes purchased credits when the balance is above zero", () => {
    const out = formatBalance(balanceResponse({ sessionRemaining: 89.7, purchasedUsd: 12.5 }));
    expect(out).toContain("Purchased credits: $12.50");
  });

  it("omits the credits line for a zero balance", () => {
    const out = formatBalance(balanceResponse({ sessionRemaining: 89.7, purchasedUsd: 0 }));
    expect(out).not.toContain("credits");
  });

  it("appends histogram totals and the partial current bucket when stats are given", () => {
    const out = formatBalance(balanceResponse({ sessionRemaining: 89.7 }), statsResponse());
    expect(out).toContain("Requests (7d): 4,497");
    expect(out).toContain("current period: 277");
  });

  it("omits histogram lines without stats", () => {
    const out = formatBalance(balanceResponse({ sessionRemaining: 89.7 }));
    expect(out).not.toContain("Requests");
  });
});

// ============================================================================
// formatBalanceStatusColored
// ============================================================================

/** A minimal Theme stub that wraps text in a color tag for assertions. */
const fakeTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as unknown as Theme;

describe("formatBalanceStatusColored", () => {
  it("formats a compact one-line status with a quota bar", () => {
    expect(formatBalanceStatusColored(fakeTheme, balanceResponse({ sessionRemaining: 60.4 }))).toBe(
      "<success>5h ▕████░░░░░░▏ 40%</success>",
    );
  });

  it("renders one segment per window present", () => {
    expect(
      formatBalanceStatusColored(fakeTheme, balanceResponse({ sessionRemaining: 60.4, weeklyRemaining: 93 })),
    ).toBe("<success>5h ▕████░░░░░░▏ 40%</success> <success>7d ▕░░░░░░░░░░▏ 7%</success>");
  });

  it("renders a single 30d segment for a monthly-only account", () => {
    expect(formatBalanceStatusColored(fakeTheme, balanceResponse({ monthlyRemaining: 66 }))).toBe(
      "<success>30d ▕███░░░░░░░▏ 34%</success>",
    );
  });

  it("colors a segment red at 80% used or above", () => {
    expect(formatBalanceStatusColored(fakeTheme, balanceResponse({ sessionRemaining: 15 }))).toContain(
      "<error>5h ▕████████░░▏ 85%</error>",
    );
  });

  it("colors a segment yellow at 60-79% used", () => {
    expect(formatBalanceStatusColored(fakeTheme, balanceResponse({ sessionRemaining: 35 }))).toContain(
      "<warning>5h ▕██████░░░░▏ 65%</warning>",
    );
  });

  it("clamps the bar at 0% and 100%", () => {
    expect(formatBalanceStatusColored(fakeTheme, balanceResponse({ sessionRemaining: 100 }))).toBe(
      "<success>5h ▕░░░░░░░░░░▏ 0%</success>",
    );
    expect(formatBalanceStatusColored(fakeTheme, balanceResponse({ sessionRemaining: -5 }))).toBe(
      "<error>5h ▕██████████▏ 100%</error>",
    );
  });

  it("clamps a remaining_percent above 100 to 0% used", () => {
    expect(formatBalanceStatusColored(fakeTheme, balanceResponse({ sessionRemaining: 105 }))).toBe(
      "<success>5h ▕░░░░░░░░░░▏ 0%</success>",
    );
  });

  it("returns an empty string when no windows are present", () => {
    expect(formatBalanceStatusColored(fakeTheme, { purchased: { balance_usd: 1 } })).toBe("");
  });
});
