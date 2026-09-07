import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { fetchUsage, formatUsage, formatUsageStatusColored, isUsageLimit, isUsageResponse } from "../usage.ts";

// --- Helpers ---

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A minimal valid /api/usage response with a single monthly bucket. */
function usageResponse(
  overrides: {
    monthlyUsage?: number;
    monthlyModels?: Array<{ name: string; request_count: number }>;
    activity?: unknown;
  } = {},
) {
  return {
    limits: {
      monthly: {
        usage: overrides.monthlyUsage ?? 0.34,
        models: overrides.monthlyModels ?? [{ name: "model-a", request_count: 2 }],
      },
    },
    activity: overrides.activity ?? { cost: "0.00000", period: { type: "last_4_weeks" } },
  };
}

/** A minimal valid /api/usage response with session and weekly buckets. */
function sessionWeeklyResponse(
  overrides: {
    sessionUsage?: number;
    weeklyUsage?: number;
    models?: Array<{ name: string; request_count: number }>;
  } = {},
) {
  const models = overrides.models ?? [{ name: "model-a", request_count: 2 }];
  return {
    limits: {
      session: { usage: overrides.sessionUsage ?? 0.4, models },
      weekly: { usage: overrides.weeklyUsage ?? 0.07, models },
    },
    activity: { cost: "0.00000", period: { type: "last_4_weeks" } },
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

describe("isUsageLimit", () => {
  it("accepts a valid limit", () => {
    expect(isUsageLimit({ usage: 0.5, models: [{ name: "a", request_count: 1 }] })).toBe(true);
  });

  it("accepts an empty models array", () => {
    expect(isUsageLimit({ usage: 0.5, models: [] })).toBe(true);
  });

  it("rejects a non-number usage", () => {
    expect(isUsageLimit({ usage: "0.5", models: [] })).toBe(false);
  });

  it("rejects a missing models array", () => {
    expect(isUsageLimit({ usage: 0.5 })).toBe(false);
  });

  it("rejects a model entry missing a field", () => {
    expect(isUsageLimit({ usage: 0.5, models: [{ name: "a" }] })).toBe(false);
    expect(isUsageLimit({ usage: 0.5, models: [{ request_count: 1 }] })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isUsageLimit(null)).toBe(false);
    expect(isUsageLimit("string")).toBe(false);
  });
});

// ============================================================================
// isUsageResponse
// ============================================================================

describe("isUsageResponse", () => {
  it("accepts a monthly-only response", () => {
    expect(isUsageResponse(usageResponse())).toBe(true);
  });

  it("accepts a session plus weekly response", () => {
    expect(isUsageResponse(sessionWeeklyResponse())).toBe(true);
  });

  it("rejects a response missing limits", () => {
    expect(isUsageResponse({})).toBe(false);
  });

  it("rejects a monthly-only response missing the monthly limit", () => {
    const data = usageResponse();
    delete (data.limits as { monthly?: unknown }).monthly;
    expect(isUsageResponse(data)).toBe(false);
  });

  it("accepts a session-only response", () => {
    const data = sessionWeeklyResponse();
    delete (data.limits as { weekly?: unknown }).weekly;
    expect(isUsageResponse(data)).toBe(true);
  });

  it("accepts a monthly plus weekly response", () => {
    const data = sessionWeeklyResponse();
    (data.limits as Record<string, unknown>).monthly = data.limits.session;
    expect(isUsageResponse(data)).toBe(true);
  });

  it("rejects a response with no valid limit buckets", () => {
    const data = sessionWeeklyResponse();
    (data.limits.session as { usage?: unknown }).usage = "0.4";
    (data.limits.weekly as { usage?: unknown }).usage = "0.07";
    expect(isUsageResponse(data)).toBe(false);
  });

  it("rejects a response with a malformed monthly limit", () => {
    const data = usageResponse();
    (data.limits.monthly as { usage?: unknown }).usage = "0.5";
    expect(isUsageResponse(data)).toBe(false);
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
    expect(data.limits.monthly?.usage).toBe(0.34);
  });

  it("returns parsed session and weekly usage on a 200 response", async () => {
    mockFetch(200, sessionWeeklyResponse());
    const data = await fetchUsage("key");
    expect(data.limits.session?.usage).toBe(0.4);
    expect(data.limits.weekly?.usage).toBe(0.07);
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
    mockFetch(200, { limits: { monthly: { usage: "x", models: [] } } });
    await expect(fetchUsage("key")).rejects.toThrow(/unexpected response shape/);
  });
});

// ============================================================================
// formatUsage
// ============================================================================

describe("formatUsage", () => {
  it("formats the monthly percentage and per-model counts", () => {
    const out = formatUsage(usageResponse());
    expect(out).toContain("Monthly (30d): 34%");
    expect(out).toContain("- model-a: 2 requests");
  });

  it("formats session and weekly percentages and per-model counts", () => {
    const out = formatUsage(sessionWeeklyResponse());
    expect(out).toContain("Session (5h): 40%");
    expect(out).toContain("Weekly (7d): 7%");
    expect(out).toContain("- model-a: 2 requests");
  });

  it("includes the activity cost when present", () => {
    const out = formatUsage(usageResponse());
    expect(out).toContain("Activity (4wk): $0.00000");
  });

  it("omits the activity line when cost is absent", () => {
    const out = formatUsage(usageResponse({ activity: {} }));
    expect(out).not.toContain("Activity");
  });

  it("uses singular for a single request", () => {
    const out = formatUsage(usageResponse({ monthlyModels: [{ name: "a", request_count: 1 }] }));
    expect(out).toContain("- a: 1 request");
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
