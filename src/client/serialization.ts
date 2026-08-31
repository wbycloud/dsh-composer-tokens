/**
 * Draft serialization for token counting — mirrors the exact send path
 * (dsh-client-ui-conversation sinkSerialized, L1315–1340): expand every inline
 * reference range to its model form via the owning source's codec, reassemble
 * with plain slices between spans, trim. The conversation machine sorts
 * occurrences by offset at mint time, so no re-sort is needed here.
 */

export interface OccurrenceLike {
  source: string;
  ref: string;
  offset: number;
  length: number;
}

export type SerializeOne = (occurrence: OccurrenceLike) => Promise<string>;

/** Serialized draft length is capped (design §4.6); beyond the cap the caller
 * counts the first segment exactly and estimates the remainder. */
export const MAX_COUNT_CHARS = 100_000;

export interface CountResult {
  value: number;
  exact: boolean;
  truncated: boolean;
}

/**
 * Count a draft the way the user will send it.
 * - No occurrences → synchronous exact count of draft.trim().
 * - Occurrences → callback must supply serialization (or null to permit the
 *   display estimate — the caller then marks exact=false).
 */
export function countDraft(
  draft: string,
  occurrences: readonly OccurrenceLike[],
  count: (text: string) => number,
  serialize: ((occurrences: readonly OccurrenceLike[]) => Promise<string | null>) | null
): CountResult | Promise<CountResult> {
  const trimmed = draft.trim();
  if (trimmed.length > MAX_COUNT_CHARS) {
    // v1 cap: exact on the first segment, heuristic remainder flagged `~`.
    const head = trimmed.slice(0, MAX_COUNT_CHARS);
    const tail = trimmed.slice(MAX_COUNT_CHARS);
    return {
      value: count(head) + Math.ceil(tail.length / 4),
      exact: false,
      truncated: true,
    };
  }
  if (occurrences.length === 0) {
    return { value: count(trimmed), exact: true, truncated: false };
  }
  if (serialize === null) {
    return { value: count(trimmed), exact: false, truncated: false };
  }
  return serialize(occurrences).then((serialized) => {
    if (serialized === null) return { value: count(trimmed), exact: false, truncated: false };
    return { value: count(serialized), exact: true, truncated: false };
  });
}

/** Async reassembly identical to the send path. */
export async function serializeDraft(
  draft: string,
  occurrences: readonly OccurrenceLike[],
  serializeOne: SerializeOne
): Promise<string> {
  const parts = await Promise.all(
    occurrences.map(async (o) => ({
      offset: o.offset,
      length: o.length,
      text: await serializeOne(o),
    }))
  );
  let out = "";
  let cursor = 0;
  for (const part of parts) {
    out += draft.slice(cursor, part.offset) + part.text;
    cursor = part.offset + part.length;
  }
  out += draft.slice(cursor);
  return out.trim();
}