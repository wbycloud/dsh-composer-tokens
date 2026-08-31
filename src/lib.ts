/**
 * Non-UI surface of the plugin, bundled separately (lib/index.mjs) so the
 * node --test suite can import the pure logic without React or the DSH
 * module-loader wrapper.
 */
export { HeuristicEngine } from "./client/engine/heuristic";
export { JsBpeEngine } from "./client/engine/js-bpe";
export { resolveEngine, resetEngineRegistryForTests, HEURISTIC_REASON } from "./client/engine/registry";
export type { TokenizerEngine, EngineResolution } from "./client/engine/types";
export {
  computeBadge,
  resolveBaseline,
  fixedOverhead,
  formatCount,
  costLevel,
  costStyles,
  COST_THRESHOLDS,
  type CostLevel,
  type CostColors,
  sumUsage,
  seamOf,
  SEAM_TABLE,
  type PressureView,
  type UsageView,
  type BreakdownView,
  type BadgeNumbers,
  type BaselineResolution,
  type BaselineSource,
} from "./client/compute";
export {
  countDraft,
  serializeDraft,
  MAX_COUNT_CHARS,
  type OccurrenceLike,
  type CountResult,
} from "./client/serialization";
export { createTrailingDebouncer, type Debouncer } from "./client/debounce";
export { matchFamily, overrideFor, readOverrides, isCustomUrl, OVERRIDES_KEY } from "./client/family";
export { TOKENIZER_FAMILIES } from "./client/tokenizer-data";
export { allFamilies, familyById } from "./client/data/loader";