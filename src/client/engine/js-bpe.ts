import { Tokenizer } from "@huggingface/tokenizers";
import type { TokenizerEngine } from "./types";

/**
 * JsBpeEngine — exact byte-level BPE counting through the current
 * `@huggingface/tokenizers` implementation (v0.1.3, pure JavaScript, no WASM —
 * see docs/m0-spike.md V1). Construction is synchronous once the tokenizer
 * JSON text is available (JSON.parse + Tokenizer constructor); count() is
 * synchronous. The registry owns the async data loading.
 */
export class JsBpeEngine implements TokenizerEngine {
  readonly exact = true;

  private readonly tokenizer: Tokenizer;
  private readonly familyLabel: string;

  constructor(tokenizerJson: string, tokenizerConfigJson: string | undefined, familyLabel: string) {
    const json = JSON.parse(tokenizerJson) as object;
    const config = tokenizerConfigJson === undefined ? {} : (JSON.parse(tokenizerConfigJson) as object);
    this.familyLabel = familyLabel;
    this.tokenizer = new Tokenizer(json, config);
  }

  get label(): string {
    return this.familyLabel;
  }

  count(text: string): number {
    return this.tokenizer.encode(text, { add_special_tokens: false }).ids.length;
  }
}