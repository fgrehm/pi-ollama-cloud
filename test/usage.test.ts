import { afterEach, describe, expect, it } from "vitest";
import { fetchUsage, formatUsage, formatUsageStatus, isUsageLimit, isUsageResponse } from "../usage.ts";

// --- Helpers ---

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A minimal valid /api/usage response. */
function usageResponse(overrides: {
  sessionUsage?: number;
  weeklyUsage?: number;
  sessionModels?: Array<{ name: string; request_count: number }>;
  weeklyModels?: Array<{ name: string; request_count: number }>;
  activity?: unknown;
} = {}) {
  return {
    limits: {
      session: {
        usage: overrides.sessionUsage ?? 0.34,
        models: overrides.sessionModels ?? [{ name: "model-a", request_count: 2 }],
      },
      weekly: {
        usage: overrides.weeklyUsage ?? 0.45,
        models: overrides.weeklyModels ?? [{ name: "model-a", request_count: 5 }],
      },
    },
    activity: overrides.activity ?? { cost: "0.00000", period: { type: "last_4_weeks" } },
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
  it("accepts a valid response", () => {
    expect(isUsageResponse(usageResponse())).toBe(true);
  });

  it("rejects a response missing limits", () => {
    expect(isUsageResponse({})).toBe(false);
  });

  it("rejects a response missing the weekly limit", () => {
    const data = usageResponse();
    delete (data.limits as { weekly?: unknown }).weekly;
    expect(isUsageResponse(data)).toBe(false);
  });

  it("rejects a response with a malformed session limit", () => {
    const data = usageResponse();
    (data.limits.session as { usage?: unknown }).usage = "0.5";
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
    expect(data.limits.session.usage).toBe(0.34);
    expect(data.limits.weekly.usage).toBe(0.45);
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
    mockFetch(200, { limits: { session: { usage: "x", models: [] } } });
    await expect(fetchUsage("key")).rejects.toThrow(/unexpected response shape/);
  });
});

// ============================================================================
// formatUsage
// ============================================================================

describe("formatUsage", () => {
  it("formats session and weekly percentages and per-model counts", () => {
    const out = formatUsage(usageResponse());
    expect(out).toContain("Session (5h): 34%");
    expect(out).toContain("- model-a: 2 requests");
    expect(out).toContain("Weekly (7d): 45%");
    expect(out).toContain("- model-a: 5 requests");
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
    const out = formatUsage(usageResponse({ sessionModels: [{ name: "a", request_count: 1 }] }));
    expect(out).toContain("- a: 1 request");
  });
});

// ============================================================================
// formatUsageStatus
// ============================================================================

describe("formatUsageStatus", () => {
  it("formats a compact one-line status with quota bars", () => {
    expect(formatUsageStatus(usageResponse())).toBe("5h ▕███░░░░░░░▏ 34% 7d ▕████░░░░░░▏ 45%");
  });

  it("clamps the bar at 0% and 100%", () => {
    expect(formatUsageStatus(usageResponse({ sessionUsage: 0, weeklyUsage: 1 }))).toBe(
      "5h ▕░░░░░░░░░░▏ 0% 7d ▕██████████▏ 100%",
    );
  });
});
