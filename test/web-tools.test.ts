import { describe, expect, it } from "vitest";
import { isFetchResponse, isSearchResponse } from "../web-tools.ts";

// ============================================================================
// isFetchResponse
// ============================================================================

describe("isFetchResponse", () => {
  it("accepts a response with a links array", () => {
    expect(isFetchResponse({ title: "t", content: "c", links: ["https://a"] })).toBe(true);
  });

  it("accepts a response with null links (pages with no extractable links)", () => {
    expect(isFetchResponse({ title: "t", content: "c", links: null })).toBe(true);
  });

  it("rejects a response missing title", () => {
    expect(isFetchResponse({ content: "c", links: [] })).toBe(false);
  });

  it("rejects a response missing content", () => {
    expect(isFetchResponse({ title: "t", links: [] })).toBe(false);
  });

  it("rejects a response whose links is neither an array nor null", () => {
    expect(isFetchResponse({ title: "t", content: "c", links: "nope" })).toBe(false);
  });

  it("rejects a links array containing a non-string entry", () => {
    expect(isFetchResponse({ title: "t", content: "c", links: ["https://a", 42] })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isFetchResponse(null)).toBe(false);
    expect(isFetchResponse("string")).toBe(false);
    expect(isFetchResponse(42)).toBe(false);
  });
});

// ============================================================================
// isSearchResponse
// ============================================================================

describe("isSearchResponse", () => {
  it("accepts a response with a results array", () => {
    expect(isSearchResponse({ results: [{ title: "t", url: "u", content: "c" }] })).toBe(true);
  });

  it("rejects a response without results", () => {
    expect(isSearchResponse({})).toBe(false);
  });

  it("rejects a results entry missing a field", () => {
    expect(isSearchResponse({ results: [{ title: "t", url: "u" }] })).toBe(false);
    expect(isSearchResponse({ results: [{ title: "t", content: "c" }] })).toBe(false);
    expect(isSearchResponse({ results: [{ url: "u", content: "c" }] })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isSearchResponse(null)).toBe(false);
    expect(isSearchResponse("string")).toBe(false);
  });
});
