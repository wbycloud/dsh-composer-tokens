import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBadge, resolveBaseline, seamOf, occupancyLevel, SEAM_TABLE, sumUsage, fixedOverhead } from "../lib-test/index.mjs";

test("seam table: deepseek family = 3, unknown families default 3", () => {
  assert.equal(SEAM_TABLE["deepseek"], 3);
  assert.equal(seamOf("deepseek"), 3);
  assert.equal(seamOf(undefined), 3);
  assert.equal(seamOf("unknown-family"), 3);
});

test("computeBadge: total = baseline + draft + seam (draft present)", () => {
  const r = computeBadge({ projectedTokens: 1000, contextWindow: 128000 }, 250, "deepseek");
  assert.deepEqual(r, {
    baseline: 1000, draftTokens: 250, seam: 3, total: 1253, occupancy: 1,
    fixedTokens: 0, baselineSource: "anchor",
  });
});

test("computeBadge: empty draft shows bare baseline (no seam)", () => {
  const r = computeBadge({ projectedTokens: 1000, contextWindow: 128000 }, 0, "deepseek", true);
  assert.equal(r.total, 1000);
  assert.equal(r.seam, 0);
});

test("computeBadge: baseline falls back pressureTokens -> 0", () => {
  const a = computeBadge({ pressureTokens: 500, contextWindow: 1000 }, 10, "deepseek");
  assert.equal(a.baseline, 500);
  assert.equal(a.baselineSource, "anchor");
  const b = computeBadge(undefined, 10, "deepseek");
  assert.equal(b.baseline, 0);
  assert.equal(b.baselineSource, "none");
});

test("resolveBaseline: real anchor wins and never double-counts the overhead", () => {
  const breakdown = { systemTokens: 400, toolsTokens: 120 };
  const r = resolveBaseline({ projectedTokens: 1000, pressureTokens: 900 }, breakdown, 550);
  assert.equal(r.baseline, 1000); // projectedTokens preferred
  assert.equal(r.source, "anchor");
  assert.equal(r.fixedTokens, 520); // overhead exposed for tooltip only, NOT added
});

test("resolveBaseline: no anchor -> breakdown overhead becomes the baseline", () => {
  const r = resolveBaseline(undefined, { systemTokens: 400, toolsTokens: 120 }, 550);
  assert.equal(r.baseline, 520);
  assert.equal(r.source, "breakdown");
  assert.equal(fixedOverhead({ systemTokens: 400, toolsTokens: 120 }), 520);
});

test("resolveBaseline: breakdown empty -> last-fixed placeholder", () => {
  const r = resolveBaseline(undefined, undefined, 550);
  assert.equal(r.baseline, 550);
  assert.equal(r.source, "last-fixed");
  // a zero/stale cached value must not shadow the 0 default
  assert.equal(resolveBaseline(undefined, undefined, 0).source, "none");
});

test("resolveBaseline: everything missing -> 0 + none", () => {
  assert.deepEqual(resolveBaseline(undefined, undefined, undefined), { baseline: 0, fixedTokens: 0, source: "none" });
});

test("computeBadge: fresh-session placeholder total (baseline from breakdown)", () => {
  const r = computeBadge(undefined, 0, "deepseek", true, { systemTokens: 400, toolsTokens: 120 }, 550);
  assert.equal(r.baseline, 520);
  assert.equal(r.total, 520);
  assert.equal(r.baselineSource, "breakdown");
  assert.equal(r.fixedTokens, 520);
});

test("computeBadge: no anchor + no breakdown uses last-fixed placeholder", () => {
  const r = computeBadge(undefined, 30, "deepseek", false, undefined, 550);
  assert.equal(r.baseline, 550);
  assert.equal(r.total, 550 + 30 + 3);
  assert.equal(r.baselineSource, "last-fixed");
});

test("computeBadge: occupancy clamp at 100 and rounding", () => {
  const huge = computeBadge({ projectedTokens: 120000, contextWindow: 128000 }, 100000, "deepseek");
  assert.equal(huge.occupancy, 100);
  assert.equal(computeBadge({ projectedTokens: 0, contextWindow: 10000 }, 2501, "deepseek").occupancy, 25);
  assert.equal(computeBadge({ projectedTokens: 500 }, 10, "deepseek").occupancy, null);
});

test("occupancyLevel thresholds (80 warn / 95 danger)", () => {
  assert.equal(occupancyLevel(null), "normal");
  assert.equal(occupancyLevel(0), "normal");
  assert.equal(occupancyLevel(79), "normal");
  assert.equal(occupancyLevel(80), "warn");
  assert.equal(occupancyLevel(94), "warn");
  assert.equal(occupancyLevel(95), "danger");
  assert.equal(occupancyLevel(100), "danger");
});

test("sumUsage: four buckets total", () => {
  assert.equal(sumUsage(undefined), 0);
  assert.equal(
    sumUsage({ uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 5 }),
    155
  );
  assert.equal(sumUsage({}), 0);
});