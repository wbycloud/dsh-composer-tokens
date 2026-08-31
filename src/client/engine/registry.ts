import { JsBpeEngine } from "./js-bpe";
import { HeuristicEngine } from "./heuristic";
import { loadFamilyData, familyById } from "../data/loader";
import { matchFamily, overrideFor, isCustomUrl } from "../family";
import type { EngineResolution } from "./types";

/**
 * EngineRegistry — modelId → engine, lazy, LRU (max 3 families cached).
 * Resolution order: user override → builtin family table → HeuristicEngine.
 * Load failures (offline without cache, hash mismatch, engine error) always
 * fall back to HeuristicEngine with a machine-readable reason.
 */

export const HEURISTIC_REASON = {
  unknown: "unknown-model",
  unavailable: "data-unavailable",
  failed: "load-failed",
  custom: "custom-url-failed",
} as const;

const heuristic = new HeuristicEngine();

const engineCache = new Map<string, { engine: JsBpeEngine; lastUse: number }>();
const MAX_CACHED_FAMILIES = 3;

function touch(familyId: string, engine: JsBpeEngine): void {
  engineCache.set(familyId, { engine, lastUse: Date.now() });
  if (engineCache.size > MAX_CACHED_FAMILIES) {
    let oldestKey: string | undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [key, entry] of engineCache) {
      if (entry.lastUse < oldest) {
        oldest = entry.lastUse;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) engineCache.delete(oldestKey);
  }
}

function cached(familyId: string): JsBpeEngine | undefined {
  const entry = engineCache.get(familyId);
  if (entry === undefined) return undefined;
  entry.lastUse = Date.now();
  return entry.engine;
}

const resolving = new Map<string, Promise<EngineResolution>>();

function heuristicResolution(reason: string): EngineResolution {
  return { status: "heuristic", engine: heuristic, fallbackReason: reason };
}

async function buildEngine(familyId: string): Promise<EngineResolution> {
  const family = familyById(familyId);
  if (family === undefined) return heuristicResolution(HEURISTIC_REASON.unknown);
  const data = await loadFamilyData(family);
  if (data === null) return heuristicResolution(HEURISTIC_REASON.unavailable);
  try {
    const engine = new JsBpeEngine(
      data.files["tokenizer.json"] ?? "",
      data.files["tokenizer_config.json"],
      family.label
    );
    touch(familyId, engine);
    return { status: "ready", engine, familyId };
  } catch {
    return heuristicResolution(HEURISTIC_REASON.failed);
  }
}

/** Resolve (and cache) the engine for a model id + optional provider. */
export function resolveEngine(model: string | undefined): Promise<EngineResolution> {
  if (model === undefined || model.length === 0) {
    return Promise.resolve(heuristicResolution(HEURISTIC_REASON.unknown));
  }
  const override = overrideFor(model);
  if (override !== undefined && isCustomUrl(override)) {
    // User-supplied tokenizer.json URL: resolve without family caching.
    const key = `custom:${override}`;
    const pending = resolving.get(key);
    if (pending !== undefined) return pending;
    const promise = (async (): Promise<EngineResolution> => {
      try {
        const res = await fetch(override, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) return heuristicResolution(HEURISTIC_REASON.custom);
        const text = await res.text();
        const engine = new JsBpeEngine(text, undefined, `自定义 ${override}`);
        return { status: "ready", engine };
      } catch {
        return heuristicResolution(HEURISTIC_REASON.custom);
      } finally {
        resolving.delete(key);
      }
    })();
    resolving.set(key, promise);
    return promise;
  }

  const matched = matchFamily(model);
  const familyId = override !== undefined ? override : matched?.familyId;
  if (familyId === undefined) {
    return Promise.resolve(heuristicResolution(HEURISTIC_REASON.unknown));
  }
  const hit = cached(familyId);
  if (hit !== undefined) return Promise.resolve({ status: "ready", engine: hit, familyId });

  const pending = resolving.get(familyId);
  if (pending !== undefined) return pending;
  const promise = buildEngine(familyId).finally(() => resolving.delete(familyId));
  resolving.set(familyId, promise);
  return promise;
}

export function resetEngineRegistryForTests(): void {
  engineCache.clear();
  resolving.clear();
}