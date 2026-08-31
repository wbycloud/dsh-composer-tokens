import { test } from "node:test";
import assert from "node:assert/strict";
import { countDraft, serializeDraft, MAX_COUNT_CHARS } from "../lib-test/index.mjs";

const countFn = (text) => Math.ceil(text.length / 4);

test("countDraft: no occurrences -> synchronous exact trimmed count", () => {
  const r = countDraft("  hello world  ", [], countFn, null);
  assert.deepEqual(r, { value: Math.ceil("hello world".length / 4), exact: true, truncated: false });
});

test("countDraft: trailing whitespace is not counted", () => {
  const a = countDraft("hello", [], countFn, null);
  const b = countDraft("hello   \n", [], countFn, null);
  assert.deepEqual(a, b);
});

test("countDraft: with occurrences and no serializer -> estimate marked inexact", () => {
  const r = countDraft("see @skill foo", [{ source: "skill", ref: "r1", offset: 4, length: 10 }], countFn, null);
  assert.equal(r.exact, false);
  assert.equal(r.value, countFn("see @skill foo"));
});

test("countDraft: with occurrences -> exact after serialization (same as send path)", async () => {
  const occ = [
    { source: "skill", ref: "r1", offset: 4, length: 6 },
    { source: "file", ref: "f2", offset: 20, length: 5 },
  ];
  const draft = "see @skill foo then @file bar.txt";
  const serializer = async (occs) => serializeDraft(draft, occs, async (o) => (o.source === "skill" ? "<skill>foo</skill>" : "<file>bar.txt</file>"));
  const r = await countDraft(draft, occ, countFn, serializer);
  assert.equal(r.exact, true);
  assert.equal(r.truncated, false);
  // Only the @trigger spans are replaced; the surrounding words survive
  // (identical to the send path's splice).
  assert.equal(r.value, countFn("see <skill>foo</skill> foo then <file>bar.txt</file> bar.txt"));
});

test("serializeDraft: reassembly identical to the send-path splice", async () => {
  const draft = "prefix @a token mid @b tail";
  const out = await serializeDraft(draft, [
    { source: "a", ref: "a1", offset: 7, length: 2 },
    { source: "b", ref: "b1", offset: 20, length: 2 },
  ], async (o) => `<${o.ref}>`);
  assert.equal(out, "prefix <a1> token mid <b1> tail");
});

test("serializeDraft: trims the final serialized text", async () => {
  const out = await serializeDraft("  @a x  ", [{ source: "a", ref: "a1", offset: 2, length: 2 }], async () => "<a1>");
  assert.equal(out, "<a1> x");
});

test("countDraft: over-length cap -> head exact + heuristic tail, marked inexact", () => {
  const big = "x".repeat(MAX_COUNT_CHARS + 40);
  const r = countDraft(big, [], countFn, null);
  assert.equal(r.truncated, true);
  assert.equal(r.exact, false);
  assert.equal(r.value, Math.ceil(MAX_COUNT_CHARS / 4) + Math.ceil(40 / 4));
});

test("countDraft: serializer failure -> display estimate kept (inexact)", async () => {
  const occ = [{ source: "skill", ref: "r1", offset: 4, length: 10 }];
  const draft = "see @skill foo";
  const r = await countDraft(draft, occ, countFn, async () => null);
  assert.equal(r.exact, false);
  assert.equal(r.value, countFn(draft));
});