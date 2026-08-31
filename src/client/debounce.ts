/**
 * Trailing debounce with timing control — pure enough for unit tests
 * (design §4.6: 250ms trailing; tokenize never runs per keystroke, only
 * after the user pauses).
 */

export interface Debouncer<T> {
  /** Schedule an invocation; trailing semantics (latest args win). */
  schedule(value: T): void;
  /** Cancel the pending invocation if any. */
  cancel(): void;
}

export function createTrailingDebouncer<T>(
  fn: (value: T) => void,
  waitMs: number,
  now: () => number = () => Date.now(),
  setTimer: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle: unknown) => void = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
): Debouncer<T> {
  let handle: unknown = undefined;
  let scheduledAt = 0;
  let pending: T | undefined;
  const fire = () => {
    handle = undefined;
    const value = pending;
    pending = undefined;
    if (value !== undefined) fn(value);
  };
  return {
    schedule(value: T) {
      pending = value;
      if (handle !== undefined) clearTimer(handle);
      scheduledAt = now();
      handle = setTimer(fire, waitMs);
    },
    cancel() {
      if (handle !== undefined) clearTimer(handle);
      handle = undefined;
      pending = undefined;
    },
  };
}