/**
 * Display math (§3.2 / §4.5) and formatting — pure functions, unit-tested.
 */

/**
 * Template-frame seam constant: `projectedTokens` prices the existing
 * surface only; the new user message adds a JSON/role frame worth ~2–4 tokens
 * (design §4.4). v1 uses a flat empirical table (DeepSeek family = 3);
 * v1.1 replaces this with a calibration loop.
 */
export const SEAM_TABLE: Record<string, number> = {
  deepseek: 3,
  "gpt-o200k": 3,
  "gpt-cl100k": 3,
};

export function seamOf(familyId: string | undefined): number {
  return familyId === undefined ? 3 : (SEAM_TABLE[familyId] ?? 3);
}

export interface PressureView {
  contextWindow?: number;
  pressureTokens?: number;
  projectedTokens?: number;
}

export interface UsageView {
  uncachedInputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * contextBreakdown wire view (dsh-token-meter L166–213): heuristic prices of
 * the last assembled canonical request envelope. `systemTokens` covers the
 * full system prompt (persona / skills / time-context etc.) and `toolsTokens`
 * the tool schemas, both at the official 4-char/token density — refreshed on
 * every `request/header` broadcast.
 */
export interface BreakdownView {
  systemTokens?: number;
  toolsTokens?: number;
  messageTokens?: number;
}

/** Fixed per-request overhead: system prompt + tool definitions (heuristic). */
export function fixedOverhead(breakdown: BreakdownView | undefined): number {
  return ((breakdown?.systemTokens ?? 0) + (breakdown?.toolsTokens ?? 0)) || 0;
}

export type BaselineSource = "anchor" | "breakdown" | "last-fixed" | "none";

export interface BaselineResolution {
  baseline: number;
  fixedTokens: number;
  source: BaselineSource;
}

/**
 * Resolve the history baseline without double-counting the system/tools
 * overhead:
 * 1. `projectedTokens ?? pressureTokens` — a real anchor prices the FULL next
 *    request (provider inputTokens, or estimateHeader+surface — both already
 *    include system+tools, dsh-token-meter L596–616), so no overhead is added.
 * 2. `fixedOverhead(breakdown)` — after the first request broadcast, the
 *    heuristic system+tools price for a fresh session.
 * 3. `lastFixedTokens` — previous session's overhead as a placeholder before
 *    the first request of a brand-new session (marked estimated).
 * 4. 0 — first-ever use; tooltip explains calibration after the first send.
 */
export function resolveBaseline(
  pressure: PressureView | undefined,
  breakdown: BreakdownView | undefined,
  lastFixedTokens: number | undefined
): BaselineResolution {
  const anchor = pressure?.projectedTokens ?? pressure?.pressureTokens;
  if (anchor !== undefined) return { baseline: anchor, fixedTokens: fixedOverhead(breakdown), source: "anchor" };
  const fixed = fixedOverhead(breakdown);
  if (fixed > 0) return { baseline: fixed, fixedTokens: fixed, source: "breakdown" };
  if (lastFixedTokens !== undefined && lastFixedTokens > 0) return { baseline: lastFixedTokens, fixedTokens: lastFixedTokens, source: "last-fixed" };
  return { baseline: 0, fixedTokens: 0, source: "none" };
}

export interface BadgeNumbers {
  baseline: number;
  draftTokens: number;
  seam: number;
  total: number;
  occupancy: number | null;
  fixedTokens: number;
  baselineSource: BaselineSource;
}

/**
 * §3.2: total = baseline + count(serializedDraft) + seam;
 * occupancy = min(100, round(total / contextWindow * 100)).
 * Baseline resolution without double-counting the system/tools overhead —
 * see {@link resolveBaseline}. The seam frame constant applies only while a
 * draft exists (empty draft shows the bare baseline — design §4.5).
 */
export function computeBadge(
  pressure: PressureView | undefined,
  draftTokens: number,
  familyId: string | undefined,
  draftEmpty = false,
  breakdown: BreakdownView | undefined = undefined,
  lastFixedTokens: number | undefined = undefined
): BadgeNumbers {
  const { baseline, fixedTokens, source } = resolveBaseline(pressure, breakdown, lastFixedTokens);
  const seam = draftEmpty ? 0 : seamOf(familyId);
  const total = baseline + draftTokens + seam;
  const capacity = pressure?.contextWindow;
  const occupancy = capacity !== undefined && capacity > 0 ? Math.min(100, Math.round((total / capacity) * 100)) : null;
  return { baseline, draftTokens, seam, total, occupancy, fixedTokens, baselineSource: source };
}

/** Occupancy color threshold (design §4.5: 80% warn / 95% red). */
export function occupancyLevel(occupancy: number | null): "normal" | "warn" | "danger" {
  if (occupancy === null) return "normal";
  if (occupancy >= 95) return "danger";
  if (occupancy >= 80) return "warn";
  return "normal";
}

/** 12345 → "12,345" */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** Cumulative real usage (four buckets, tokenUsage totals). */
export function sumUsage(usage: UsageView | undefined): number {
  if (usage === undefined) return 0;
  return (
    (usage.uncachedInputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  );
}