/** Engine contract shared by every counting implementation. */

export interface TokenizerEngine {
  /**
   * Synchronous token count for the raw text.
   * Exact engines must be fully initialized before count() is called
   * (the registry guarantees that); heuristic engines are always ready.
   */
  count(text: string): number;
  /** false → UI prefixes the badge with `~` (estimate). */
  exact: boolean;
  /** Stable human label for the tooltip ("DeepSeek 128k BPE" / "估算 len/4"). */
  label: string;
}

export interface EngineResolution {
  status: "loading" | "ready" | "heuristic";
  engine?: TokenizerEngine;
  /** family id when a real tokenizer data source matched, else undefined. */
  familyId?: string;
  /** machine-readable reason for heuristic fallback (for tooltip). */
  fallbackReason?: string;
}