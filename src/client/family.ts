import { allFamilies } from "./data/loader";

/**
 * Model identity → tokenizer family resolution with user override support.
 * Override persists in localStorage under `dsh-composer-tokens.overrides`:
 *   { "<modelId or prefix>": "<builtin family id> | <http(s) tokenizer.json URL>" }
 * Exact modelId match wins, then longest prefix match, then the builtin
 * family regex table.
 */

export const OVERRIDES_KEY = "dsh-composer-tokens.overrides";

export function readOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function overrideFor(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  const m = model.toLowerCase();
  const overrides = readOverrides();
  if (overrides[m] !== undefined) return overrides[m];
  // longest prefix match
  let best: string | undefined;
  let bestLen = -1;
  for (const [key, value] of Object.entries(overrides)) {
    const k = key.toLowerCase();
    if (k.length > bestLen && m.startsWith(k)) {
      best = value;
      bestLen = k.length;
    }
  }
  return best;
}

export function isCustomUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Resolve the builtin family for a model id (ignores overrides). */
export function matchFamily(model: string | undefined): { familyId: string } | undefined {
  if (model === undefined) return undefined;
  const m = model.toLowerCase();
  for (const fam of allFamilies()) {
    if (new RegExp(fam.match, "i").test(m)) return { familyId: fam.id };
  }
  return undefined;
}