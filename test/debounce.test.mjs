import { test } from "node:test";
import assert from "node:assert/strict";
import { createTrailingDebouncer } from "../lib-test/index.mjs";

function fakeTimers() {
  let nowMs = 0;
  let seq = 0;
  const tasks = new Map();
  return {
    now: () => nowMs,
    setTimer: (fn, ms) => {
      const id = ++seq;
      tasks.set(id, { fn, at: nowMs + ms });
      return id;
    },
    clearTimer: (id) => tasks.delete(id),
    advance(ms) {
      nowMs += ms;
      const due = [...tasks.values()].filter((t) => t.at <= nowMs).sort((a, b) => a.at - b.at);
      for (const t of due) {
        tasks.delete([...tasks.entries()].find(([, v]) => v === t)?.[0]);
        t.fn();
      }
    },
    pending() {
      return tasks.size;
    },
  };
}

test("trailing debounce: fires once after the quiet window with latest args", () => {
  const clock = fakeTimers();
  const calls = [];
  const d = createTrailingDebouncer((value) => calls.push(value), 250, clock.now, clock.setTimer, clock.clearTimer);
  d.schedule(1);
  clock.advance(50);
  d.schedule(2);
  clock.advance(50);
  d.schedule(3);
  assert.equal(calls.length, 0);
  clock.advance(250); // fires 250ms after the last schedule
  assert.deepEqual(calls, [3]);
  clock.advance(1000);
  assert.deepEqual(calls, [3], "no extra fire");
});

test("trailing debounce: cancel drops the pending fire", () => {
  const clock = fakeTimers();
  const calls = [];
  const d = createTrailingDebouncer((v) => calls.push(v), 250, clock.now, clock.setTimer, clock.clearTimer);
  d.schedule("x");
  d.cancel();
  clock.advance(1000);
  assert.deepEqual(calls, []);
});

test("trailing debounce: 250ms quiet window collapses a typing burst", () => {
  const clock = fakeTimers();
  const calls = [];
  const d = createTrailingDebouncer((v) => calls.push(v), 250, clock.now, clock.setTimer, clock.clearTimer);
  for (let i = 0; i < 30; i++) {
    d.schedule(i);
    clock.advance(30); // typing cadence < 250ms
  }
  assert.equal(calls.length, 0);
  clock.advance(250);
  assert.deepEqual(calls, [29]);
});