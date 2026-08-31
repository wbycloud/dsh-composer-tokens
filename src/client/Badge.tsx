import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TokenizerEngine, EngineResolution } from "./engine/types";
import { HeuristicEngine } from "./engine/heuristic";
import { resolveEngine } from "./engine/registry";
import { countDraft, serializeDraft, type OccurrenceLike, MAX_COUNT_CHARS } from "./serialization";
import { computeBadge, formatCount, occupancyLevel, sumUsage, fixedOverhead, type PressureView, type UsageView, type BreakdownView } from "./compute";
import { createTrailingDebouncer } from "./debounce";

const DEBOUNCE_MS = 250;
const MODEL_REQUERY_COOLDOWN_MS = 3000;
const LAST_FIXED_KEY = "dsh-composer-tokens.lastFixedTokens";

/** Previous session's fixed overhead (system+tools heuristic), used as a
 * placeholder for a brand-new session before its first request broadcasts a
 * header. Read defensively; never throws. */
function readLastFixed(): number | undefined {
  try {
    const raw = localStorage.getItem(LAST_FIXED_KEY);
    if (raw === null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function writeLastFixed(value: number): void {
  try {
    localStorage.setItem(LAST_FIXED_KEY, String(Math.round(value)));
  } catch {
    /* private mode / quota — placeholder only */
  }
}

/** Minimal shapes of handle-ish values crossing the slot boundary (never serialized). */
interface SessionModelsApi {
  sessions?: {
    models?(payload: { sessionId: string }): Promise<{ result?: { ok: boolean; value?: { current?: { provider?: string; model?: string } } } }>;
  };
}

interface TriggerControllerLike {
  serializeReference(source: string, ref: string, signal?: AbortSignal): Promise<string>;
}

interface InputLike {
  draft?: string;
  draftRev?: number;
  phase?: string;
  occurrences?: readonly OccurrenceLike[];
}

export interface TokenMeterBadgeProps {
  /** standard kit */
  useProjection?: (key: string) => unknown;
  sessionId?: string;
  t?: (key: string) => string;
  /** owner props (zone = { session, input }) */
  session?: unknown;
  input?: InputLike;
  /** slot inject */
  api?: SessionModelsApi | null | undefined;
  controller?: TriggerControllerLike | null | undefined;
}

interface DraftCount {
  value: number;
  exact: boolean;
  truncated: boolean;
}

const fallbackEngine: TokenizerEngine = new HeuristicEngine();

function useSessionModel(props: TokenMeterBadgeProps): [string | undefined, () => void] {
  const { api, sessionId } = props;
  const [model, setModel] = useState<string | undefined>(undefined);
  const lastQuery = useRef(0);
  // Reset the cooldown when the session changes so a fresh session is never
  // stuck with a stale (possibly undefined) model for up to 3s.
  useEffect(() => {
    lastQuery.current = 0;
  }, [sessionId]);
  const refresh = useCallback(() => {
    if (api?.sessions?.models === undefined || sessionId === undefined) return;
    const now = Date.now();
    if (now - lastQuery.current < MODEL_REQUERY_COOLDOWN_MS) return;
    lastQuery.current = now;
    api.sessions
      .models({ sessionId })
      .then(({ result }) => {
        if (result?.ok === true) setModel(result.value?.current?.model);
      })
      .catch(() => {
        /* keep the previous model identity */
      });
  }, [api, sessionId]);
  return [model, refresh];
}

export function TokenMeterBadge(props: TokenMeterBadgeProps): null | JSX.Element {
  const { sessionId, input, t, useProjection, api, controller } = props;

  // The renderer only mounts this slot when a session + input exist
  // (hero/blank zone === undefined, dsh-client-ui-conversation L7191–7242);
  // the guard is defensive only.
  if (sessionId === undefined || input === undefined) return null;

  const pressure = (useProjection?.("contextPressure") ?? undefined) as PressureView | undefined;
  const usage = (useProjection?.("tokenUsage") ?? undefined) as UsageView | undefined;
  const breakdown = (useProjection?.("contextBreakdown") ?? undefined) as BreakdownView | undefined;

  const [lastFixed, setLastFixed] = useState<number | undefined>(readLastFixed);

  const [model, refreshModel] = useSessionModel(props);
  const [engineRes, setEngineRes] = useState<EngineResolution>({ status: "heuristic", engine: fallbackEngine, fallbackReason: "unknown-model" });
  const [draftCount, setDraftCount] = useState<DraftCount | null>(null);
  const [hover, setHover] = useState(false);

  // Model identity: on mount/session change (forced), and on projection ticks
  // (cooldown 3s — there is no model-switch wire event, see docs/m0-spike.md V3).
  useEffect(() => {
    refreshModel();
  }, [refreshModel, pressure === undefined, sessionId]);
  useEffect(() => {
    refreshModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Engine: lazy per model id; registry caches by family (LRU).
  useEffect(() => {
    let cancelled = false;
    if (model === undefined) {
      setEngineRes({ status: "heuristic", engine: fallbackEngine, fallbackReason: "unknown-model" });
      return;
    }
    setEngineRes({ status: "loading" });
    resolveEngine(model).then((res) => {
      if (!cancelled) setEngineRes(res);
    });
    return () => {
      cancelled = true;
    };
  }, [model]);

  // Persist the fixed overhead (system+tools heuristic) for fresh-session
  // placeholder use; the first real anchor of this session supersedes it.
  useEffect(() => {
    const fixed = fixedOverhead(breakdown);
    if (fixed > 0) {
      setLastFixed(fixed);
      writeLastFixed(fixed);
    }
  }, [breakdown]);

  const inputDraft = input.draft ?? "";
  const occurrences = input.occurrences ?? [];
  const engine = engineRes.status === "ready" && engineRes.engine !== undefined ? engineRes.engine : fallbackEngine;
  const loading = engineRes.status === "loading";

  // Debounced draft count (250ms trailing, design §4.6). Serialization via the
  // send-path controller (design §4.4); while expanding refs the badge shows
  // the display-text estimate marked `~`.
  useEffect(() => {
    let cancelled = false;
    const current = inputDraft;
    const currentOcc = occurrences;
    const serialize =
      controller === undefined || controller === null
        ? null
        : (occs: readonly OccurrenceLike[]) =>
            serializeDraft(current, occs, (o) => controller.serializeReference(o.source, o.ref)).then(
              (text) => text,
              () => null
            );
    const fire = (payload: { draft: string; occ: readonly OccurrenceLike[] }) => {
      const apply = (r: DraftCount) => {
        if (!cancelled) setDraftCount(r);
      };
      const result = countDraft(payload.draft, payload.occ, (text) => engine.count(text), serialize);
      if (result instanceof Promise) {
        // Display-text estimate now, exact after serialization (or on failure).
        apply({ value: engine.count(payload.draft.trim()), exact: false, truncated: false });
        result.then(apply).catch(() => {});
      } else {
        apply(result);
      }
    };
    const debouncer = createTrailingDebouncer<{ draft: string; occ: readonly OccurrenceLike[] }>(fire, DEBOUNCE_MS);
    debouncer.schedule({ draft: current, occ: currentOcc });
    return () => {
      cancelled = true;
      debouncer.cancel();
    };
  }, [inputDraft, occurrences, engine, controller]);

  const numbers = useMemo(() => {
    const draftTokens = draftCount?.value ?? 0;
    return computeBadge(pressure, draftTokens, engineRes.familyId, inputDraft.trim() === "", breakdown, lastFixed);
  }, [pressure, draftCount, engineRes.familyId, inputDraft, breakdown, lastFixed]);

  const level = occupancyLevel(numbers.occupancy);
  // The「~」marker covers non-exact engines AND estimated baselines
  // (breakdown / last-fixed placeholders); real anchors render「≈」.
  const showLoading = loading && inputDraft.trim() !== "";
  const estimate = numbers.baselineSource !== "anchor" || !(draftCount?.exact ?? false);
  const label =
    showLoading || draftCount === null
      ? t?.("badge.loading") ?? "…"
      : `${estimate ? "~" : "≈"}${formatCount(numbers.total)}${numbers.occupancy !== null ? ` · ${numbers.occupancy}%` : ""}`;
  const badgeColor =
    level === "danger" ? "var(--dsw-alias-state-error-primary)" : level === "warn" ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-label-tertiary)";

  const usageTotal = sumUsage(usage);
  const modelLabel = model ?? t?.("tooltip.unknownModel") ?? "Unknown model";
  const engineLabel = engineRes.status === "ready" && engineRes.engine !== undefined ? engineRes.engine.label : t?.("tooltip.estimated") ?? "Estimated";

  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", alignSelf: "stretch" }}>
      <span
        role="button"
        tabIndex={0}
        aria-label={t?.("badge.aria") ?? "expected token cost"}
        data-composer-tokens-badge=""
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        style={{
          fontSize: 11,
          lineHeight: 1.2,
          whiteSpace: "nowrap",
          color: badgeColor,
          fontVariantNumeric: "tabular-nums",
          cursor: "default",
          padding: "2px 6px",
          border: "1px solid var(--dsw-alias-border-l1)",
          borderRadius: 999,
          background: "var(--dsw-specific-tip)",
          userSelect: "none",
          opacity: numbers.total === 0 ? 0.55 : 1,
        }}
      >
        {label}
      </span>
      {hover && (
        <span
          role="tooltip"
          data-composer-tokens-tooltip=""
          style={{
            position: "absolute",
            right: 0,
            bottom: "calc(100% + 6px)",
            zIndex: 1000,
            minWidth: 220,
            maxWidth: 320,
            background: "var(--dsw-specific-tip)",
            border: "1px solid var(--dsw-alias-border-l2)",
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
            padding: "8px 10px",
            fontSize: 12,
            lineHeight: 1.6,
            color: "var(--dsw-alias-label-primary)",
            textAlign: "left",
            whiteSpace: "pre-line",
          }}
        >
          <span style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>{t?.("tooltip.title")}</span>
          <span style={{ display: "block" }}>
            {t?.("tooltip.total")}: <b>{formatCount(numbers.total)}</b>{" "}
            {estimate ? t?.("badge.tooltip.estimated") : t?.("badge.tooltip.exact")}
          </span>
          <span style={{ display: "block" }}>
            {t?.("tooltip.baseline")}: {formatCount(numbers.baseline)}{" "}
            <i style={{ opacity: 0.65 }}>
              {numbers.baselineSource === "anchor"
                ? t?.("tooltip.baselineAnchor")
                : numbers.baselineSource === "breakdown"
                  ? t?.("tooltip.baselineBreakdown")
                  : numbers.baselineSource === "last-fixed"
                    ? t?.("tooltip.baselineLastFixed")
                    : t?.("tooltip.baselineNone")}
            </i>
            {engineRes.status === "heuristic" ? ` (${t?.("badge.estimate")})` : ""}
          </span>
          <span style={{ display: "block" }}>
            {t?.("tooltip.fixed")}: {formatCount(numbers.fixedTokens)}{" "}
            <i style={{ opacity: 0.65 }}>({t?.("tooltip.fixedNote")})</i>
          </span>
          <span style={{ display: "block" }}>
            {t?.("tooltip.draft")}: +{formatCount(numbers.draftTokens)}
            {!estimate && numbers.draftTokens > 0 ? ` ${t?.("tooltip.refPending") ?? ""}` : ""}
          </span>
          <span style={{ display: "block" }}>
            {t?.("tooltip.seam")}: +{formatCount(numbers.seam)}
          </span>
          <span style={{ display: "block", opacity: 0.8 }}>
            {t?.("tooltip.skill")}
          </span>
          {numbers.occupancy !== null && (
            <span style={{ display: "block" }}>
              {t?.("tooltip.occupancy")}: {numbers.occupancy}% / {formatCount(pressure?.contextWindow ?? 0)}
            </span>
          )}
          <span style={{ display: "block", marginTop: 4, borderTop: "1px solid var(--dsw-alias-border-l1)", paddingTop: 4 }}>
            {t?.("tooltip.usage")}: {formatCount(usageTotal)}
          </span>
          <span style={{ display: "block" }}>
            {t?.("tooltip.model")}: {modelLabel} <i style={{ opacity: 0.65 }}>({engineLabel})</i>
          </span>
          {numbers.baselineSource === "none" && (
            <span style={{ display: "block", color: "var(--dsw-alias-state-warn-primary)" }}>{t?.("tooltip.calibrate")}</span>
          )}
          {draftCount?.truncated === true && (
            <span style={{ display: "block", color: "var(--dsw-alias-state-warn-primary)" }}>{t?.("tooltip.truncated")}</span>
          )}
        </span>
      )}
    </span>
  );
}