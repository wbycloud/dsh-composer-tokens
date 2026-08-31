import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JsBpeEngine, HeuristicEngine, matchFamily, formatCount } from "../lib-test/index.mjs";

// Ground truth in this file was generated with the OFFICIAL Rust tokenizers
// (0.23.1) — scripts/reference-counts.py. Any mismatch means the JS engine
// deviates from the reference implementation.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spike = resolve(root, ".spike");

async function engineFor(dir) {
  const json = await readFile(resolve(spike, dir, "tokenizer.json"), "utf8");
  const config = await readFile(resolve(spike, dir, "tokenizer_config.json"), "utf8").catch(() => undefined);
  return new JsBpeEngine(json, config, dir);
}

test("cl100k: hello world == 2 ids (OpenAI documented ground truth)", async () => {
  const e = await engineFor("Xenova-gpt-4");
  assert.equal(e.count("hello world"), 2);
  assert.equal(e.exact, true);
});

test("DeepSeek-V3: token counts match the official Rust tokenizers", async () => {
  const e = await engineFor("deepseek-ai-DeepSeek-V3");
  const cases = [
    ["Hello World! This is a test of the token counter.", 12],
    ["你好，世界！这是中文分词测试。", 9],
    ["const f = (x) => x * 2;\nfunction g(n) { return n + 1; }", 24],
    ["🎉🎊🚀✨", 7],
  ];
  for (const [text, expected] of cases) {
    assert.equal(e.count(text), expected, `expected ${expected} tokens for ${JSON.stringify(text)}`);
  }
});

test("gpt families: spot counts vs official reference", async () => {
  const o200k = await engineFor("wellflat-o200k_base_tokenizer");
  const cl100k = await engineFor("Xenova-gpt-4");
  assert.equal(o200k.count("你好，世界！这是中文分词测试。"), 10);
  assert.equal(cl100k.count("你好，世界！这是中文分词测试。"), 16);
  assert.equal(o200k.count("🎉🎊🚀✨"), 7);
  assert.equal(cl100k.count("🎉🎊🚀✨"), 11);
});

test("DeepSeek-V3: raw engine counts whitespace; trimming lives at the draft layer", async () => {
  const e = await engineFor("deepseek-ai-DeepSeek-V3");
  assert.equal(e.count("   hello   "), e.count("hello") + 2);
});

test("DeepSeek-V3: BPE merge boundary — 'tokenization' vs 'token ization'", async () => {
  const e = await engineFor("deepseek-ai-DeepSeek-V3");
  assert.equal(e.count("tokenization"), e.count("token ization") - 1);
  assert.equal(e.count("Transformer"), 1);
  assert.equal(e.count("Trans former"), 2);
});

test("DeepSeek-V3: newline is a separate byte token", async () => {
  const e = await engineFor("deepseek-ai-DeepSeek-V3");
  assert.equal(e.count("a\nb"), e.count("ab") + 2);
});

test("HeuristicEngine: ceil(len/4), exact=false", () => {
  const h = new HeuristicEngine();
  assert.equal(h.count("abcd"), 1);
  assert.equal(h.count("abcde"), 2);
  assert.equal(h.count("你好世界"), 1);
  assert.equal(h.exact, false);
  assert.match(h.label, /估算/);
});

test("matchFamily: deepseek / gpt families", () => {
  assert.equal(matchFamily("deepseek-v4-flash").familyId, "deepseek");
  assert.equal(matchFamily("deepseek-chat").familyId, "deepseek");
  assert.equal(matchFamily("gpt-5").familyId, "gpt-o200k");
  assert.equal(matchFamily("gpt-4o").familyId, "gpt-o200k");
  assert.equal(matchFamily("o3-mini").familyId, "gpt-o200k");
  assert.equal(matchFamily("gpt-4").familyId, "gpt-cl100k");
  assert.equal(matchFamily("gpt-3.5-turbo").familyId, "gpt-cl100k");
  assert.equal(matchFamily("qwen-72b"), undefined);
  assert.equal(matchFamily(undefined), undefined);
});

test("formatCount", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(12345), "12,345");
  assert.equal(formatCount(128000), "128,000");
});