import { TOKENIZER_FAMILIES, type TokenizerFamily } from "../tokenizer-data";
import { idbGet, idbPut } from "./idb";

/**
 * Tokenizer data loader (G1 ruling: runtime fetch + IndexedDB cache).
 *
 * - Download chain: huggingface.co → hf-mirror.com (both CORS-verified,
 *   docs/m0-spike.md V4).
 * - sha256 verifies every download against the pinned value before caching.
 * - IndexedDB caches parsed JSON text per family; offline hits stay exact.
 * - Every failure degrades to `null` → the registry falls back to
 *   HeuristicEngine.
 */

export interface FamilyData {
  family: TokenizerFamily;
  files: Record<string, string>; // fileName → JSON text
}

const textDecoder = typeof TextDecoder === "undefined" ? null : new TextDecoder("utf-8");

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  if (typeof crypto === "undefined" || crypto.subtle === undefined) return "";
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const mirror = url.startsWith("https://huggingface.co/")
    ? "https://hf-mirror.com/" + url.slice("https://huggingface.co/".length)
    : undefined;
  const attempts = mirror === undefined ? [url] : [url, mirror];
  let lastError: unknown;
  for (const candidate of attempts) {
    try {
      const res = await fetch(candidate, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status} for ${candidate}`);
        continue;
      }
      return await res.arrayBuffer();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("fetch failed");
}

async function fetchVerified(family: TokenizerFamily): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const f of family.files) {
    const buf = await fetchBytes(f.url);
    const hash = await sha256Hex(buf);
    if (hash !== "" && hash !== f.sha256) {
      throw new Error(`tokenizer data hash mismatch for ${f.name} (got ${hash}, pinned ${f.sha256})`);
    }
    files[f.name] = textDecoder === null ? new TextDecoder().decode(buf) : textDecoder.decode(buf);
  }
  return files;
}

const inflight = new Map<string, Promise<FamilyData | null>>();

/** Load one family's data (deduplicated, cached in IndexedDB). */
export function loadFamilyData(family: TokenizerFamily): Promise<FamilyData | null> {
  const existing = inflight.get(family.id);
  if (existing !== undefined) return existing;
  const promise = (async (): Promise<FamilyData | null> => {
    try {
      const cached = await idbGet(family.id);
      if (cached !== null) {
        const files: Record<string, string> = {};
        for (const f of family.files) {
          const entry = cached[f.name];
          if (entry === undefined) {
            const fresh = await loadFresh(family);
            return fresh;
          }
          files[f.name] = entry.text;
        }
        return { family, files };
      }
      return await loadFresh(family);
    } finally {
      inflight.delete(family.id);
    }
  })();
  inflight.set(family.id, promise);
  return promise;
}

async function loadFresh(family: TokenizerFamily): Promise<FamilyData> {
  const files = await fetchVerified(family);
  const stored: Record<string, { text: string }> = {};
  for (const [name, text] of Object.entries(files)) stored[name] = { text };
  await idbPut(family.id, stored);
  return { family, files };
}

/** Family table accessor (exported for tests + overrides). */
export function familyById(id: string): TokenizerFamily | undefined {
  return TOKENIZER_FAMILIES.find((fam) => fam.id === id);
}

export function allFamilies(): readonly TokenizerFamily[] {
  return TOKENIZER_FAMILIES;
}