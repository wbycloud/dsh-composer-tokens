import type { TokenizerEngine } from "./types";

/**
 * HeuristicEngine — fallback with the same口径 as the official token-meter
 * estimate (4 characters per token, design.md §2.1): ceil(len / 4).
 * Synchronous, always ready, exact = false → UI shows「~」.
 */
export class HeuristicEngine implements TokenizerEngine {
  readonly exact = false;
  readonly label = "估算 (len/4)";

  count(text: string): number {
    return Math.ceil(text.length / 4);
  }
}