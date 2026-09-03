/**
 * Generate pricing.generated.ts from ollama.com/pricing.
 *
 * Not shipped (not in package.json `files`). Run via `npm run generate-models`
 * (chained before the model generator) or directly via `tsx scripts/generate-pricing.ts`.
 *
 * Prices are the official per-1M-token rates from the model pricing table on
 * https://ollama.com/pricing (the page renders the table server-side, so it is
 * fetched as HTML and the table rows are extracted with a regex — no HTML
 * parser dependency needed). Ollama Cloud is subscription-billed, so these are
 * NOT actual charges; they make `/cost` show comparable usage. Prices are never
 * hand-typed: this script fetches them and writes pricing.generated.ts (do not
 * edit by hand).
 *
 * The pricing table lists one row per model family with bare or tagged names
 * (e.g. `deepseek-v4-flash`, `gpt-oss:120b`), while the live catalog can hold
 * several tagged variants per family (e.g. `deepseek-v4-flash:0731`,
 * `deepseek-v4-flash:preview`). A catalog ID matches a pricing row when both
 * are equal or when the catalog ID extends the row name with a `:tag` suffix,
 * so every variant of a family inherits the family price. Catalog IDs with no
 * matching row get a zero price and a warning listing them, so the next change
 * adds one row to the table upstream.
 *
 * The table has no cache-write column, so `cacheWrite` is always 0.
 */

import { writeFileSync } from "node:fs";
import { fetchModelIds } from "../models.ts";

const PRICING_URL = "https://ollama.com/pricing";
const TIMEOUT_MS = 15000;

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * One row of the model pricing table: model name (anchor text — the `href`
 * points at the family library page and is not unique per row), then input,
 * cached input, and output prices.
 */
const ROW_RE =
  /<td[^>]*><a href="\/library\/[^"]+"[^>]*>([^<]+)<\/a><\/td>\s*<td[^>]*>\$([\d.]+)<\/td>\s*<td[^>]*>\$([\d.]+)<\/td>\s*<td[^>]*>\$([\d.]+)<\/td>/g;

const ZERO: ModelPrice = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

async function fetchPricingPage(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(PRICING_URL, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`pricing page returned ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract the per-model pricing table from the pricing page HTML.
 * Returns one entry per table row, keyed by the model name.
 */
function parsePricingRows(html: string): Map<string, ModelPrice> {
  const rows = new Map<string, ModelPrice>();
  for (const match of html.matchAll(ROW_RE)) {
    const [, name, input, cacheRead, output] = match;
    const price = {
      input: Number(input),
      cacheRead: Number(cacheRead),
      output: Number(output),
      cacheWrite: 0,
    };
    // The regex hard-codes the column order (Input / Cached input / Output).
    // A column reorder would still parse, so flag values that would imply a
    // swapped layout instead of silently writing wrong prices.
    if (price.cacheRead > price.input) {
      throw new Error(
        `pricing row "${name}" has cacheRead (${price.cacheRead}) > input (${price.input}); the table column order may have changed`,
      );
    }
    rows.set(name, price);
  }
  if (rows.size === 0) {
    throw new Error("no pricing rows found on the pricing page — table layout changed?");
  }
  return rows;
}

/**
 * Resolve the price for a catalog ID from the pricing rows.
 * Exact match first, then a `:tag` suffix match so every variant of a
 * family inherits the family price. Returns the matched row name alongside
 * the price so callers can track table coverage.
 */
function resolvePrice(id: string, rows: Map<string, ModelPrice>): { name: string; price: ModelPrice } | undefined {
  const exact = rows.get(id);
  if (exact) return { name: id, price: exact };
  const colon = id.lastIndexOf(":");
  if (colon > 0) {
    const family = id.slice(0, colon);
    const familyPrice = rows.get(family);
    if (familyPrice) return { name: family, price: familyPrice };
  }
  return undefined;
}

async function main(): Promise<void> {
  console.log(`Fetching ${PRICING_URL}...`);
  const rows = parsePricingRows(await fetchPricingPage());

  console.log("Fetching Ollama Cloud model list...");
  const ollamaIds = (await fetchModelIds()).sort();

  const pricing: Record<string, ModelPrice> = {};
  const warnings: string[] = [];
  const matchedRows = new Set<string>();

  for (const id of ollamaIds) {
    const match = resolvePrice(id, rows);
    if (!match) {
      pricing[id] = { ...ZERO };
      warnings.push(`no pricing row for "${id}" (zero cost)`);
      continue;
    }
    pricing[id] = match.price;
    matchedRows.add(match.name);
  }

  for (const name of rows.keys()) {
    if (!matchedRows.has(name)) {
      console.warn(`  - pricing row "${name}" matched no catalog model (informational only)`);
    }
  }

  if (warnings.length > 0) {
    console.warn("Pricing warnings:");
    for (const w of warnings) console.warn(`  - ${w}`);
  }

  const generatedAt = new Date().toISOString();
  const lines: string[] = [
    "// Auto-generated by scripts/generate-pricing.ts",
    "// Do not edit manually.",
    `// Generated: ${generatedAt}`,
    `// Model count: ${ollamaIds.length}`,
    "",
    "export interface ModelPrice {",
    "  input: number;",
    "  output: number;",
    "  cacheRead: number;",
    "  cacheWrite: number;",
    "}",
    "",
    "export const MODEL_PRICING: Record<string, ModelPrice> = {",
  ];
  for (const id of Object.keys(pricing).sort()) {
    const p = pricing[id];
    lines.push(
      `  ${JSON.stringify(id)}: { input: ${p.input}, output: ${p.output}, cacheRead: ${p.cacheRead}, cacheWrite: ${p.cacheWrite} },`,
    );
  }
  lines.push("};", "");

  writeFileSync(new URL("../pricing.generated.ts", import.meta.url), lines.join("\n"));
  console.log(`Wrote pricing.generated.ts (${ollamaIds.length} models, ${warnings.length} warnings).`);
}

await main();
